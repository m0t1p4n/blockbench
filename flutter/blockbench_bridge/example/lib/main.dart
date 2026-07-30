import 'dart:convert';
import 'dart:io';

import 'package:blockbench_bridge/blockbench_bridge.dart';
import 'package:flutter/material.dart';

void main() {
  runApp(const BlockbenchExampleApp());
}

/// A simple Minecraft "grass block" in the Java Block/Item model format.
const String kSampleModel = '''
{
	"credit": "blockbench_bridge example",
	"textures": {
		"all": "block/example_grass",
		"particle": "#all"
	},
	"elements": [
		{
			"from": [0, 0, 0],
			"to": [16, 16, 16],
			"faces": {
				"north": {"uv": [0, 0, 16, 16], "texture": "#all"},
				"east":  {"uv": [0, 0, 16, 16], "texture": "#all"},
				"south": {"uv": [0, 0, 16, 16], "texture": "#all"},
				"west":  {"uv": [0, 0, 16, 16], "texture": "#all"},
				"up":    {"uv": [0, 0, 16, 16], "texture": "#all"},
				"down":  {"uv": [0, 0, 16, 16], "texture": "#all"}
			}
		}
	]
}
''';

/// 16x16 grass-like PNG used by [kSampleModel].
const String kSampleTextureBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAgUlEQVR4AcyQMQ6AMAhFGyZP4OxN'
    'vIAm3tPBi3gDB5276eSmgemnCYSUpU0ohf6+fErTtnyRoBRcDQCe807jeqTaHB9h3rN8Y20WB1d+'
    'BeLdUC+Aoe+8b0WHekIa35Y196wgpLGwrLlnhYygCTxuTIDHjQlAZ5obN0Bz4wagGzz/AAAA//8F'
    'oDh1AAAABklEQVQDAJbvaxFgTtAVAAAAAElFTkSuQmCC';

class BlockbenchExampleApp extends StatelessWidget {
  const BlockbenchExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Blockbench Bridge Example',
      theme: ThemeData.dark(useMaterial3: true),
      home: const EditorScreen(),
    );
  }
}

class EditorScreen extends StatefulWidget {
  const EditorScreen({super.key});

  @override
  State<EditorScreen> createState() => _EditorScreenState();
}

class _EditorScreenState extends State<EditorScreen> {
  BlockbenchController? _controller;
  bool _ready = false;
  bool _unsavedChanges = false;

  void _onControllerCreated(BlockbenchController controller) {
    _controller = controller;

    // Files saved from inside the Blockbench UI (Ctrl+S / File > Export).
    controller.onExport.listen((file) async {
      final target = File('${Directory.systemTemp.path}/${file.name}');
      await target.writeAsBytes(file.bytes);
      _showMessage('Saved from Blockbench UI: ${target.path} '
          '(${file.bytes.length} bytes)');
    });

    controller.onEdited.listen((info) {
      if (mounted) setState(() => _unsavedChanges = !info.saved);
    });
  }

  void _onReady(BlockbenchController controller) {
    setState(() => _ready = true);
    _loadSampleModel();
  }

  Future<void> _loadSampleModel() async {
    final controller = _controller;
    if (controller == null) return;
    try {
      final info = await controller.loadModel(
        name: 'example_grass.json',
        modelJson: kSampleModel,
        textures: {'block/example_grass': base64Decode(kSampleTextureBase64)},
      );
      _showMessage('Loaded "${info.name}" (${info.format}, '
          '${info.textureCount} texture(s))');
    } on BlockbenchBridgeException catch (err) {
      _showMessage('Load failed: ${err.message}');
    }
  }

  Future<void> _saveModel() async {
    final controller = _controller;
    if (controller == null) return;
    try {
      // The Minecraft-format file (for a resource pack)...
      final javaModel = await controller.getModel(codec: 'auto');
      // ...and the full Blockbench project (best for re-editing later).
      final project = await controller.getModel(
          codec: 'project', includeTextures: false, markSaved: true);

      final dir = Directory.systemTemp.path;
      final modelFile = File('$dir/${javaModel.fileName}');
      await modelFile.writeAsString(javaModel.content);
      final projectFile = File('$dir/${project.name}.${project.extension}');
      await projectFile.writeAsString(project.content);
      for (final texture in javaModel.textures) {
        await File('$dir/${texture.name}').writeAsBytes(texture.bytes);
      }

      setState(() => _unsavedChanges = false);
      _showMessage('Saved ${javaModel.fileName}, ${project.name}.'
          '${project.extension} and ${javaModel.textures.length} texture(s) '
          'to $dir');
    } on BlockbenchBridgeException catch (err) {
      _showMessage('Save failed: ${err.message}');
    }
  }

  void _showMessage(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Blockbench${_unsavedChanges ? ' *' : ''}'),
        actions: [
          IconButton(
            tooltip: 'Load sample model',
            icon: const Icon(Icons.file_open),
            onPressed: _ready ? _loadSampleModel : null,
          ),
          IconButton(
            tooltip: 'Save model + textures',
            icon: const Icon(Icons.save),
            onPressed: _ready ? _saveModel : null,
          ),
        ],
      ),
      body: BlockbenchView(
        onControllerCreated: _onControllerCreated,
        onBlockbenchReady: _onReady,
      ),
    );
  }
}
