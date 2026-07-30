import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'asset_server.dart';
import 'controller.dart';

/// Embeds the Blockbench editor.
///
/// Starts a loopback HTTP server for the bundled web build, creates the
/// WebView and hands you a [BlockbenchController] through [onBlockbenchReady].
///
/// ```dart
/// BlockbenchView(
///   onBlockbenchReady: (controller) async {
///     await controller.loadModel(
///       name: 'stone.json',
///       modelJson: modelFileContent,
///       textures: {'block/stone': stonePngBytes},
///     );
///     controller.onExport.listen((file) => saveToDisk(file));
///   },
/// )
/// ```
class BlockbenchView extends StatefulWidget {
  const BlockbenchView({
    super.key,
    this.onBlockbenchReady,
    this.onControllerCreated,
    this.assetRoot,
    this.backgroundColor = const Color(0xFF21252B),
    this.loadingBuilder,
    this.waitForProject = true,
    this.waitForProjectTimeout = const Duration(seconds: 20),
  });

  /// Called once Blockbench has fully booted and the bridge is responsive.
  final void Function(BlockbenchController controller)? onBlockbenchReady;

  /// Called as soon as the controller exists (before the page finished
  /// loading). Useful to attach [BlockbenchController.onExport] listeners
  /// early.
  final void Function(BlockbenchController controller)? onControllerCreated;

  /// Override the asset bundle location of the Blockbench web build.
  /// Defaults to the build shipped with this package.
  final String? assetRoot;

  final Color backgroundColor;

  /// Shown while Blockbench is booting.
  final WidgetBuilder? loadingBuilder;

  /// Keep the loading overlay up until the first project is opened (usually
  /// by the `loadModel` call you make in [onBlockbenchReady]), so the WebView
  /// reveals the editor with the model already in place. In embedded mode the
  /// Blockbench start screen is removed, so without this you would briefly
  /// see an empty editor shell. Set to false to reveal the UI as soon as
  /// Blockbench booted.
  final bool waitForProject;

  /// Safety limit for [waitForProject]; the overlay is removed after this
  /// duration even if no project was opened.
  final Duration waitForProjectTimeout;

  @override
  State<BlockbenchView> createState() => _BlockbenchViewState();
}

class _BlockbenchViewState extends State<BlockbenchView> {
  late final BlockbenchAssetServer _server;
  WebViewController? _webViewController;
  BlockbenchController? _controller;
  bool _ready = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _server = BlockbenchAssetServer(
      assetRoot: widget.assetRoot ??
          'packages/blockbench_bridge/assets/blockbench_web',
    );
    _initialize();
  }

  Future<void> _initialize() async {
    try {
      final base = await _server.start();

      final webViewController = WebViewController()
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        ..setBackgroundColor(widget.backgroundColor);

      final controller = BlockbenchController(webViewController);
      _webViewController = webViewController;
      _controller = controller;
      widget.onControllerCreated?.call(controller);

      await webViewController.addJavaScriptChannel(
        kBlockbenchChannelName,
        onMessageReceived: (message) =>
            controller.handleChannelMessage(message.message),
      );
      webViewController.setNavigationDelegate(NavigationDelegate(
        onPageStarted: (_) => controller.resetReadyState(),
        onWebResourceError: (error) {
          // Only fail hard when the main document cannot load
          if (error.isForMainFrame == true && mounted && !_ready) {
            setState(() => _error = error.description);
          }
        },
      ));

      await webViewController
          .loadRequest(base.resolve('index.html?flutter=1'));

      await controller.ready;
      if (!mounted) return;

      if (widget.waitForProject) {
        // Subscribe before onBlockbenchReady so the project opened there
        // cannot slip through unnoticed.
        final firstProject = controller.events
            .firstWhere((event) =>
                event.type == 'project_selected' ||
                event.type == 'project_created' ||
                event.type == 'edited')
            .then<void>((_) {}, onError: (_) {});
        widget.onBlockbenchReady?.call(controller);
        await Future.any([
          firstProject,
          Future<void>.delayed(widget.waitForProjectTimeout),
        ]);
        if (!mounted) return;
        setState(() => _ready = true);
      } else {
        setState(() => _ready = true);
        widget.onBlockbenchReady?.call(controller);
      }
    } catch (err) {
      if (mounted) setState(() => _error = '$err');
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    _server.stop();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final webViewController = _webViewController;
    if (_error != null) {
      return ColoredBox(
        color: widget.backgroundColor,
        child: Center(
          child: Text(
            'Failed to load Blockbench:\n$_error',
            style: const TextStyle(color: Colors.white70),
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    return Stack(
      children: [
        if (webViewController != null)
          WebViewWidget(controller: webViewController),
        if (!_ready)
          Positioned.fill(
            child: widget.loadingBuilder?.call(context) ??
                ColoredBox(
                  color: widget.backgroundColor,
                  child: const Center(child: CircularProgressIndicator()),
                ),
          ),
      ],
    );
  }
}
