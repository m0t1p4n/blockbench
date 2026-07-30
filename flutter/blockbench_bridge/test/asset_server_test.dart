import 'dart:convert';
import 'dart:io';
import 'dart:typed_data' show BytesBuilder;

import 'package:blockbench_bridge/blockbench_bridge.dart';
import 'package:flutter_test/flutter_test.dart';

/// Minimal HTTP GET over a raw socket, so the test is unaffected by the
/// flutter_test HttpClient mock.
Future<(int, String)> rawGet(Uri base, String path) async {
  final socket = await Socket.connect(base.host, base.port);
  socket.write('GET $path HTTP/1.1\r\nHost: ${base.host}\r\n'
      'Connection: close\r\n\r\n');
  final buffer = BytesBuilder();
  await for (final chunk in socket) {
    buffer.add(chunk);
  }
  socket.destroy();
  final response = buffer.takeBytes();
  final headerEnd = _indexOfHeaderEnd(response);
  final head = ascii.decode(response.sublist(0, headerEnd), allowInvalid: true);
  final status = int.parse(head.split(' ')[1]);
  final body = utf8.decode(response.sublist(headerEnd + 4), allowMalformed: true);
  return (status, body);
}

int _indexOfHeaderEnd(List<int> bytes) {
  for (var i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] == 13 && bytes[i + 1] == 10 && bytes[i + 2] == 13 && bytes[i + 3] == 10) {
      return i;
    }
  }
  return bytes.length;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // In tests the package's own assets are rooted directly at 'assets/...'
  final server = BlockbenchAssetServer(assetRoot: 'assets/blockbench_web');

  setUpAll(() async {
    await server.start();
  });

  tearDownAll(() async {
    await server.stop();
  });

  test('serves index.html at root', () async {
    final (status, body) = await rawGet(server.baseUri!, '/');
    expect(status, 200);
    expect(body, contains('<title>Blockbench</title>'));
    expect(body, contains('dist/bundle.js'));
  });

  test('serves the bundle with the Flutter bridge compiled in', () async {
    final (status, body) = await rawGet(server.baseUri!, '/dist/bundle.js');
    expect(status, 200);
    expect(body.length, greaterThan(1000000));
    expect(body, contains('FlutterBridge'));
    expect(body, contains('BlockbenchChannel'));
  });

  test('serves css and returns 404 for missing files', () async {
    final (cssStatus, _) = await rawGet(server.baseUri!, '/css/general.css');
    expect(cssStatus, 200);
    final (missingStatus, _) = await rawGet(server.baseUri!, '/nope.txt');
    expect(missingStatus, 404);
    // HttpServer normalizes "..", the handler rejects any that get through
    final (escapeStatus, _) = await rawGet(server.baseUri!, '/../secret');
    expect(escapeStatus, anyOf(403, 404));
  });
}
