import 'dart:io';

import 'package:flutter/services.dart' show rootBundle;

/// Serves the bundled Blockbench web build over `http://127.0.0.1:<port>`.
///
/// A loopback HTTP server is required because Blockbench is an ES-module web
/// app: WebViews block module scripts on `file://` / asset URLs, but load them
/// fine from localhost.
class BlockbenchAssetServer {
  BlockbenchAssetServer({
    this.assetRoot = 'packages/blockbench_bridge/assets/blockbench_web',
  });

  /// Root key of the Blockbench web build inside the Flutter asset bundle.
  final String assetRoot;

  HttpServer? _server;
  Uri? _baseUri;

  Uri? get baseUri => _baseUri;
  bool get isRunning => _server != null;

  static const _contentTypes = <String, String>{
    'html': 'text/html; charset=utf-8',
    'js': 'text/javascript; charset=utf-8',
    'mjs': 'text/javascript; charset=utf-8',
    'css': 'text/css; charset=utf-8',
    'json': 'application/json; charset=utf-8',
    'webmanifest': 'application/manifest+json',
    'map': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'webp': 'image/webp',
    'ico': 'image/x-icon',
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'otf': 'font/otf',
    'eot': 'application/vnd.ms-fontobject',
    'wasm': 'application/wasm',
  };

  /// Starts the server (idempotent) and returns its base URI.
  Future<Uri> start() async {
    final existing = _baseUri;
    if (existing != null) return existing;

    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server = server;
    server.listen(_handleRequest, onError: (Object _) {});
    final base = Uri.parse('http://${server.address.address}:${server.port}/');
    _baseUri = base;
    return base;
  }

  Future<void> stop() async {
    final server = _server;
    _server = null;
    _baseUri = null;
    await server?.close(force: true);
  }

  Future<void> _handleRequest(HttpRequest request) async {
    var path = Uri.decodeComponent(request.uri.path);
    if (path == '/' || path.isEmpty) path = '/index.html';
    // Prevent escaping the asset root
    if (path.contains('..')) {
      request.response.statusCode = HttpStatus.forbidden;
      await request.response.close();
      return;
    }
    try {
      final data = await rootBundle.load('$assetRoot$path');
      final extension = path.split('.').last.toLowerCase();
      final contentType = _contentTypes[extension] ?? 'application/octet-stream';
      request.response.headers.set(HttpHeaders.contentTypeHeader, contentType);
      request.response.headers.set(HttpHeaders.cacheControlHeader, 'no-cache');
      request.response.add(
        data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
      );
    } catch (_) {
      request.response.statusCode = HttpStatus.notFound;
    }
    await request.response.close();
  }
}
