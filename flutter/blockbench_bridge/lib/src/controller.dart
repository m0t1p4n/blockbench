import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:webview_flutter/webview_flutter.dart';

import 'models.dart';

/// The name of the JavaScript channel the Blockbench bridge posts to.
const String kBlockbenchChannelName = 'BlockbenchChannel';

/// High-level API for the Blockbench instance running inside a WebView.
///
/// Requests are sent with `FlutterBridge.call({id, method, params})` and the
/// matching response arrives asynchronously on the JavaScript channel as a
/// `{type: 'response', id, ok, result|error}` message.
class BlockbenchController {
  BlockbenchController(this.webViewController, {this.callTimeout = const Duration(seconds: 45)});

  final WebViewController webViewController;

  /// Maximum time to wait for a bridge call before failing.
  final Duration callTimeout;

  final Map<int, Completer<dynamic>> _pending = {};
  int _nextRequestId = 1;
  bool _disposed = false;

  Completer<void> _readyCompleter = Completer<void>();
  final StreamController<BlockbenchEvent> _events =
      StreamController<BlockbenchEvent>.broadcast();
  final StreamController<BlockbenchExportedFile> _exports =
      StreamController<BlockbenchExportedFile>.broadcast();
  final StreamController<BlockbenchProjectInfo> _edits =
      StreamController<BlockbenchProjectInfo>.broadcast();

  /// Completes once Blockbench has booted and the bridge announced itself.
  Future<void> get ready => _readyCompleter.future;
  bool get isReady => _readyCompleter.isCompleted;

  /// Every raw event coming from Blockbench.
  Stream<BlockbenchEvent> get events => _events.stream;

  /// Files saved from inside the Blockbench UI (File > Save, Ctrl+S, texture
  /// downloads, screenshots). Listen to this to persist them on the device.
  Stream<BlockbenchExportedFile> get onExport => _exports.stream;

  /// Fires (debounced) every time the user edits the model.
  Stream<BlockbenchProjectInfo> get onEdited => _edits.stream;

  /// Wire this to the WebView's JavaScript channel. Done automatically by
  /// `BlockbenchView`; call it yourself only when building a custom WebView:
  ///
  /// ```dart
  /// webViewController.addJavaScriptChannel(
  ///   kBlockbenchChannelName,
  ///   onMessageReceived: (msg) => controller.handleChannelMessage(msg.message),
  /// );
  /// ```
  void handleChannelMessage(String message) {
    Map<String, dynamic> decoded;
    try {
      decoded = jsonDecode(message) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    final type = decoded['type'] as String? ?? '';
    switch (type) {
      case 'response':
        final id = decoded['id'];
        final completer = id is int ? _pending.remove(id) : null;
        if (completer == null) return;
        if (decoded['ok'] == true) {
          completer.complete(decoded['result']);
        } else {
          completer.completeError(BlockbenchBridgeException(
              (decoded['error'] as String?) ?? 'Unknown bridge error'));
        }
        break;
      case 'ready':
        if (!_readyCompleter.isCompleted) _readyCompleter.complete();
        _events.add(BlockbenchEvent(type, decoded));
        break;
      case 'export':
        _exports.add(BlockbenchExportedFile.fromJson(decoded));
        _events.add(BlockbenchEvent(type, decoded));
        break;
      case 'edited':
        _edits.add(BlockbenchProjectInfo.fromJson(decoded));
        _events.add(BlockbenchEvent(type, decoded));
        break;
      default:
        _events.add(BlockbenchEvent(type, decoded));
    }
  }

  /// Called by `BlockbenchView` when the page is (re)loaded.
  void resetReadyState() {
    if (_readyCompleter.isCompleted) {
      _readyCompleter = Completer<void>();
    }
    _failPending('Blockbench page was reloaded');
  }

  /// Low-level bridge call. Prefer the typed methods below.
  Future<dynamic> call(String method, [Map<String, dynamic>? params]) async {
    if (_disposed) {
      throw const BlockbenchBridgeException('Controller is disposed');
    }
    final id = _nextRequestId++;
    final completer = Completer<dynamic>();
    _pending[id] = completer;

    final payload =
        jsonEncode({'id': id, 'method': method, 'params': params ?? {}});
    // jsonEncode(payload) turns the JSON text into a valid JS string literal.
    // U+2028/2029 are legal in ES2019+ strings but escape them to be safe.
    final literal = jsonEncode(payload)
        .replaceAll('\u2028', r'\u2028')
        .replaceAll('\u2029', r'\u2029');
    try {
      await webViewController.runJavaScript(
          'window.FlutterBridge && window.FlutterBridge.call($literal);');
    } catch (err) {
      _pending.remove(id);
      throw BlockbenchBridgeException('Failed to reach Blockbench: $err');
    }
    return completer.future.timeout(callTimeout, onTimeout: () {
      _pending.remove(id);
      throw BlockbenchBridgeException(
          'Bridge call "$method" timed out after ${callTimeout.inSeconds}s');
    });
  }

  // ------------------------------------------------------------------
  // Typed API
  // ------------------------------------------------------------------

  /// Checks that the bridge is alive; returns Blockbench version info.
  Future<Map<String, dynamic>> ping() async =>
      (await call('ping') as Map).cast<String, dynamic>();

  /// State of the current and all open projects.
  Future<BlockbenchProjectInfo> getState() async =>
      BlockbenchProjectInfo.fromJson(
          (await call('getState') as Map).cast<String, dynamic>());

  /// Creates a new empty project. Common formats: `java_block`, `bedrock`,
  /// `free`, `skin`.
  Future<BlockbenchProjectInfo> newProject({String format = 'java_block'}) async =>
      BlockbenchProjectInfo.fromJson(
          (await call('newProject', {'format': format}) as Map)
              .cast<String, dynamic>());

  /// Opens a Minecraft model in the editor.
  ///
  /// [name] is the file name (used for auto-detection and the project name).
  /// [modelJson] is the raw file content (Java model JSON, Bedrock geometry
  /// JSON or a .bbmodel project file).
  /// [textures] maps texture keys to PNG bytes. Keys may be simple names
  /// (`stone.png`), Java texture links (`block/stone`,
  /// `minecraft:block/stone`) or full resource-pack paths.
  /// [textureDataUrls] is an alternative to [textures] with ready-made
  /// `data:image/png;base64,...` values.
  /// [files] can provide additional referenced files, e.g. parent models for
  /// Java block models (`block/cube_all.json` -> file content).
  /// [format]: `auto` (default), `java_block`, `bedrock`, `bedrock_old` or
  /// `project` (bbmodel).
  Future<BlockbenchProjectInfo> loadModel({
    required String name,
    required String modelJson,
    Map<String, Uint8List> textures = const {},
    Map<String, String> textureDataUrls = const {},
    Map<String, String> files = const {},
    String format = 'auto',
    bool importToCurrentProject = false,
  }) async {
    final textureMap = <String, String>{...textureDataUrls};
    textures.forEach((key, bytes) {
      textureMap[key] = 'data:image/png;base64,${base64Encode(bytes)}';
    });
    final result = await call('loadModel', {
      'name': name,
      'format': format,
      'model': modelJson,
      'textures': textureMap,
      'files': files,
      'import_to_current_project': importToCurrentProject,
    });
    return BlockbenchProjectInfo.fromJson(
        (result as Map).cast<String, dynamic>());
  }

  /// Adds one texture to the currently open project.
  Future<void> addTexture({
    required String name,
    required Uint8List pngBytes,
    bool fillParticle = false,
  }) async {
    await call('addTexture', {
      'name': name,
      'data': 'data:image/png;base64,${base64Encode(pngBytes)}',
      'fill_particle': fillParticle,
    });
  }

  /// Compiles and returns the current model, including its textures.
  ///
  /// [codec]: `auto` uses the project's own format codec (e.g. Java model
  /// JSON for a Java project). Use `project` to get a full `.bbmodel` file,
  /// or any other Blockbench codec id (`bedrock`, ...).
  /// Set [markSaved] to true to clear the "unsaved changes" indicator after
  /// you persisted the result.
  Future<BlockbenchModelExport> getModel({
    String codec = 'auto',
    bool includeTextures = true,
    bool markSaved = false,
  }) async {
    final result = await call('getModel', {
      'codec': codec,
      'include_textures': includeTextures,
      'mark_saved': markSaved,
    });
    return BlockbenchModelExport.fromJson(
        (result as Map).cast<String, dynamic>());
  }

  /// All textures of the current project.
  Future<List<BlockbenchTexture>> getTextures() async {
    final result = await call('getTextures');
    return (((result as Map)['textures'] as List?) ?? const [])
        .map((t) =>
            BlockbenchTexture.fromJson((t as Map).cast<String, dynamic>()))
        .toList();
  }

  /// PNG screenshot of the 3D viewport (useful for thumbnails).
  Future<Uint8List> getScreenshot({int? width, int? height}) async {
    final result = await call('getScreenshot', {
      if (width != null) 'width': width,
      if (height != null) 'height': height,
    });
    final data = ((result as Map)['data'] as String?) ?? '';
    final comma = data.indexOf(',');
    if (comma == -1) return Uint8List(0);
    return base64Decode(data.substring(comma + 1));
  }

  /// Marks the project as saved/unsaved in the UI.
  Future<void> markSaved({bool saved = true}) async {
    await call('markSaved', {'saved': saved});
  }

  Future<void> selectProject(String uuid) async {
    await call('selectProject', {'uuid': uuid});
  }

  /// Closes the current project. With [force] the "unsaved changes" prompt is
  /// skipped.
  Future<void> closeProject({bool force = true}) async {
    await call('closeProject', {'force': force});
  }

  Future<void> undo() => call('undo');
  Future<void> redo() => call('redo');

  /// Triggers any Blockbench action by its id (e.g. `export_over`).
  Future<void> triggerAction(String actionId) async {
    await call('triggerAction', {'id': actionId});
  }

  void _failPending(String reason) {
    final pending = List.of(_pending.values);
    _pending.clear();
    for (final completer in pending) {
      if (!completer.isCompleted) {
        completer.completeError(BlockbenchBridgeException(reason));
      }
    }
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _failPending('Controller disposed');
    _events.close();
    _exports.close();
    _edits.close();
  }
}
