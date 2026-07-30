import 'dart:convert';
import 'dart:typed_data';

/// Information about the currently open Blockbench project.
class BlockbenchProjectInfo {
  const BlockbenchProjectInfo({
    required this.hasProject,
    this.uuid,
    this.name = '',
    this.format,
    this.saved = true,
    this.textureCount,
  });

  final bool hasProject;
  final String? uuid;
  final String name;

  /// Blockbench format id, e.g. `java_block`, `bedrock`, `free`.
  final String? format;
  final bool saved;
  final int? textureCount;

  factory BlockbenchProjectInfo.fromJson(Map<String, dynamic> json) {
    return BlockbenchProjectInfo(
      hasProject: json['has_project'] == true,
      uuid: json['uuid'] as String?,
      name: (json['name'] as String?) ?? '',
      format: json['format'] as String?,
      saved: json['saved'] != false,
      textureCount: json['textures'] as int?,
    );
  }

  @override
  String toString() =>
      'BlockbenchProjectInfo(name: $name, format: $format, saved: $saved)';
}

/// A texture exported from Blockbench, as a PNG data URL.
class BlockbenchTexture {
  const BlockbenchTexture({
    required this.name,
    required this.source,
    this.uuid,
    this.id,
    this.folder,
    this.namespace,
    this.particle = false,
    this.width,
    this.height,
  });

  final String name;

  /// Data URL (`data:image/png;base64,...`).
  final String source;
  final String? uuid;

  /// The texture key used by the model file (for Java models, the id in the
  /// `textures` object).
  final String? id;
  final String? folder;
  final String? namespace;
  final bool particle;
  final int? width;
  final int? height;

  /// Raw PNG bytes decoded from [source]. Returns an empty list when the
  /// source is not a data URL.
  Uint8List get bytes {
    final comma = source.indexOf(',');
    if (!source.startsWith('data:') || comma == -1) return Uint8List(0);
    return base64Decode(source.substring(comma + 1));
  }

  factory BlockbenchTexture.fromJson(Map<String, dynamic> json) {
    return BlockbenchTexture(
      name: (json['name'] as String?) ?? 'texture.png',
      source: (json['source'] as String?) ?? '',
      uuid: json['uuid'] as String?,
      id: json['id'] as String?,
      folder: json['folder'] as String?,
      namespace: json['namespace'] as String?,
      particle: json['particle'] == true,
      width: json['width'] as int?,
      height: json['height'] as int?,
    );
  }
}

/// The result of [BlockbenchController.getModel]: the compiled model file
/// plus all project textures.
class BlockbenchModelExport {
  const BlockbenchModelExport({
    required this.name,
    required this.codec,
    required this.extension,
    required this.content,
    this.format,
    this.textures = const [],
  });

  final String name;

  /// Codec used to compile the model, e.g. `java_block`, `bedrock`, `project`.
  final String codec;

  /// Suggested file extension (`json`, `bbmodel`, ...).
  final String extension;

  /// The compiled model file content (JSON text).
  final String content;
  final String? format;
  final List<BlockbenchTexture> textures;

  String get fileName => '$name.$extension';

  factory BlockbenchModelExport.fromJson(Map<String, dynamic> json) {
    return BlockbenchModelExport(
      name: (json['name'] as String?) ?? 'model',
      codec: (json['codec'] as String?) ?? 'project',
      extension: (json['extension'] as String?) ?? 'json',
      content: (json['content'] as String?) ?? '',
      format: json['format'] as String?,
      textures: ((json['textures'] as List?) ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(BlockbenchTexture.fromJson)
          .toList(),
    );
  }
}

/// A file the user saved from inside the Blockbench UI (File > Save/Export,
/// Ctrl+S, texture save, screenshot...). Delivered on
/// [BlockbenchController.onExport] instead of a browser download.
class BlockbenchExportedFile {
  const BlockbenchExportedFile({
    required this.name,
    required this.encoding,
    required this.data,
    this.fileType = '',
    this.savetype = 'text',
    this.mime,
    this.resourceId = '',
  });

  /// File name including extension, e.g. `stone.json`, `texture.png`.
  final String name;

  /// `text` or `base64`.
  final String encoding;
  final String data;

  /// Human readable type, e.g. `Java Block/Item Model`.
  final String fileType;

  /// Blockbench save type: `text`, `image`, `zip`, `buffer`, `binary`.
  final String savetype;
  final String? mime;
  final String resourceId;

  bool get isText => encoding == 'text';

  /// File content as bytes, regardless of encoding.
  Uint8List get bytes => isText
      ? Uint8List.fromList(utf8.encode(data))
      : base64Decode(data);

  /// File content as text (only meaningful when [isText] is true).
  String get text => isText ? data : utf8.decode(base64Decode(data));

  factory BlockbenchExportedFile.fromJson(Map<String, dynamic> json) {
    return BlockbenchExportedFile(
      name: (json['name'] as String?) ?? 'file',
      encoding: (json['encoding'] as String?) ?? 'text',
      data: (json['data'] as String?) ?? '',
      fileType: (json['file_type'] as String?) ?? '',
      savetype: (json['savetype'] as String?) ?? 'text',
      mime: json['mime'] as String?,
      resourceId: (json['resource_id'] as String?) ?? '',
    );
  }

  @override
  String toString() =>
      'BlockbenchExportedFile($name, $savetype, ${bytes.length} bytes)';
}

/// A raw event forwarded from Blockbench (`ready`, `edited`,
/// `project_selected`, `project_created`, `project_closed`, `quick_save`...).
class BlockbenchEvent {
  const BlockbenchEvent(this.type, this.data);

  final String type;
  final Map<String, dynamic> data;

  @override
  String toString() => 'BlockbenchEvent($type)';
}

/// Thrown when a bridge call fails inside Blockbench.
class BlockbenchBridgeException implements Exception {
  const BlockbenchBridgeException(this.message);

  final String message;

  @override
  String toString() => 'BlockbenchBridgeException: $message';
}
