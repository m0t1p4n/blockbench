# blockbench_bridge

Integrează editorul **Blockbench** într-o aplicație **Flutter** pentru a încărca,
edita și salva modele Minecraft (Java Block/Item, Bedrock, `.bbmodel`) împreună
cu texturile lor.

## Cum funcționează

```
┌─────────────────────────── Aplicația Flutter ───────────────────────────┐
│                                                                         │
│  BlockbenchController  ◄──── JSON prin canalul "BlockbenchChannel" ───┐ │
│  (loadModel/getModel,        (răspunsuri, evenimente, fișiere salvate)│ │
│   onExport, onEdited)                                                 │ │
│        │                                                              │ │
│        │ runJavaScript("FlutterBridge.call({...})")                   │ │
│        ▼                                                              │ │
│  ┌── WebView ─────────────────────────────────────────────────────────┴─┤
│  │  Blockbench (build web) + js/flutter_bridge.js                       │
│  └── încărcat de pe http://127.0.0.1:<port> (BlockbenchAssetServer) ────┤
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

1. Build-ul web al Blockbench (împreună cu modulul nou `js/flutter_bridge.js`)
   este împachetat ca asset-uri Flutter.
2. `BlockbenchAssetServer` le servește local pe `http://127.0.0.1:<port>`
   (WebView-urile nu încarcă module ES de pe `file://`).
3. `BlockbenchView` creează WebView-ul, iar `BlockbenchController` comunică cu
   editorul: cereri prin `FlutterBridge.call(...)`, răspunsuri și evenimente
   prin canalul JavaScript `BlockbenchChannel`.
4. Orice **salvare făcută din interfața Blockbench** (Ctrl+S, File → Export,
   salvare textură, screenshot) este interceptată și livrată aplicației
   Flutter prin stream-ul `onExport` — nu se mai face descărcare de browser.
5. În modul embedded (`?flutter=1` sau canal JS prezent) **pagina de start
   dispare complet**: fără start screen, fără Quick Setup / onboarding, fără
   pagina „New Tab", fără butonul „+" de tab nou și fără butonul de download —
   rămâne strict editorul. La pornire se deschide automat un **proiect
   placeholder silențios**, astfel încât editorul (viewport + panouri) este
   vizibil din prima clipă; placeholder-ul se închide singur când încarci
   primul model real prin bridge și reapare dacă se închid toate proiectele
   (utilizatorul nu vede niciodată o pagină goală). Evenimentele
   placeholder-ului nu sunt trimise către Flutter, deci `waitForProject`
   așteaptă modelul tău real. `BlockbenchView` ține implicit overlay-ul de
   încărcare până se deschide acel model (`waitForProject: true`), astfel
   încât utilizatorul vede direct editorul cu modelul încărcat.
6. **Modul preview** (`?preview=1` pe URL, sau metoda `setPreviewMode`) reduce
   editorul la un simplu vizualizator: dispar bara de meniu, bara de tab-uri,
   toolbar-urile, selectorul de moduri, sidebar-urile, panourile și bara de
   stare, iar viewport-ul 3D ocupă toată pagina — rămân doar gesturile de
   orbit / zoom. Se ascund și decorațiunile de editare desenate peste model
   (gizmo-ul de transformare, markerele de pivot, locatorii, orbit gizmo-ul
   din colț), se blochează meniurile contextuale și se forțează
   `background_rendering` — un WebView rareori are focus, iar bucla de
   randare sare cadrele fără el.

## 1. Build-ul Blockbench pentru web

Din rădăcina repo-ului Blockbench:

```bash
npm install        # doar prima dată
npm run build-web
bash flutter/blockbench_bridge/tool/sync_web_assets.sh
```

Scriptul copiază `index.html`, `dist/bundle.js`, `css/`, `font/`, `assets/`,
`lib/` în `flutter/blockbench_bridge/assets/blockbench_web/` (~11 MB).
Repetă acești pași după orice modificare în sursele Blockbench.

## 2. Adaugă pachetul în aplicația ta

În `pubspec.yaml` al aplicației:

```yaml
dependencies:
  blockbench_bridge:
    path: ../blockbench-5.1.6/flutter/blockbench_bridge   # ajustează calea
```

### Configurare per platformă

**Android** — WebView-ul încarcă `http://127.0.0.1` (cleartext local). În
`android/app/src/main/AndroidManifest.xml`:

```xml
<application
    android:usesCleartextTraffic="true"
    ... >
```

sau, mai strict, printr-un [network security config](https://developer.android.com/training/articles/security-config)
care permite cleartext doar pentru `127.0.0.1`. `minSdkVersion` ≥ 21
(cerința webview_flutter).

**iOS** — conexiunile loopback sunt în general permise de ATS; dacă totuși
primești erori App Transport Security, adaugă în `ios/Runner/Info.plist`:

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
</dict>
```

**macOS** — adaugă în ambele fișiere `.entitlements`:

```xml
<key>com.apple.security.network.client</key>
<true/>
<key>com.apple.security.network.server</key>
<true/>
```

## 3. Utilizare

```dart
import 'package:blockbench_bridge/blockbench_bridge.dart';

BlockbenchView(
  // implicit true: overlay-ul de încărcare rămâne până se deschide primul
  // proiect (modelul încărcat mai jos) — utilizatorul intră direct în editor.
  // Pune false dacă vrei să arăți editorul gol imediat după boot
  // (limita de siguranță: waitForProjectTimeout, implicit 20s).
  waitForProject: true,
  onControllerCreated: (controller) {
    // Fișiere salvate din UI-ul Blockbench (Ctrl+S / File > Export)
    controller.onExport.listen((file) async {
      // file.name    -> "stone.json" / "texture.png" / "model.bbmodel"
      // file.bytes   -> conținutul fișierului
      await File('$dir/${file.name}').writeAsBytes(file.bytes);
    });
    // Notificare la fiecare editare (debounced)
    controller.onEdited.listen((info) => print('modificat: ${info.name}'));
  },
  onBlockbenchReady: (controller) async {
    // Încarcă un model Java + textura lui
    await controller.loadModel(
      name: 'stone.json',
      modelJson: await rootBundle.loadString('assets/models/stone.json'),
      textures: {
        // cheile pot fi link-uri Java ("block/stone"), nume simple
        // ("stone.png") sau căi complete de resource pack
        'block/stone': stonePngBytes,
      },
    );
  },
)
```

### Salvarea modelului (programatic)

```dart
// Fișierul în format Minecraft (pentru resource pack / behavior pack)
final export = await controller.getModel(codec: 'auto', markSaved: true);
await File('$dir/${export.fileName}').writeAsString(export.content);
for (final texture in export.textures) {
  await File('$dir/${texture.name}').writeAsBytes(texture.bytes);
}

// Proiectul complet .bbmodel (recomandat pentru re-editare ulterioară —
// păstrează tot: texturi incluse, animații, setări)
final project = await controller.getModel(codec: 'project');
await File('$dir/${project.name}.bbmodel').writeAsString(project.content);
```

### Alte operații

```dart
await controller.newProject(format: 'java_block');  // proiect gol
await controller.addTexture(name: 'extra.png', pngBytes: bytes);
final thumb = await controller.getScreenshot(width: 256, height: 256);
await controller.undo();
final state = await controller.getState();          // saved? nume? format?
await controller.closeProject();
```

### Vizualizator fără interfață (preview)

Deschide pagina cu `?flutter=1&preview=1` (sau apelează
`setPreviewMode`) pentru a obține doar viewport-ul 3D, fără nicio bară de
redactare. Modelele cu animații pot rula în buclă:

```dart
// prima animație „idle"-ish a modelului, în buclă
await controller.call('playAnimation', {'loop': true});
// sau una anume
await controller.call('playAnimation', {'name': 'animation.allay.fly'});
await controller.call('pauseAnimation');
```

`playAnimation` comută singur pe modul `animate` (redarea rulează doar
acolo) — în preview interfața acelui mod e oricum ascunsă.

### Formate suportate la încărcare

| `format`      | Descriere                                             |
|---------------|-------------------------------------------------------|
| `auto`        | detectare automată după nume + conținut (implicit)    |
| `java_block`  | modele Java Edition `assets/.../models/**.json`       |
| `bedrock`     | geometrii Bedrock `*.geo.json` (format_version 1.12+) |
| `bedrock_old` | geometrii Bedrock vechi (1.8)                         |
| `project`     | fișiere proiect `.bbmodel`                            |

Pentru modelele Java care au `parent` (ex. `block/cube_all`), poți furniza
fișierele părinte prin parametrul `files`:

```dart
await controller.loadModel(
  name: 'my_block.json',
  modelJson: content,
  textures: {...},
  files: {'block/cube_all.json': cubeAllJsonContent},
);
```

## 4. Protocolul bridge-ului (dacă vrei alt plugin WebView)

Partea JavaScript (`js/flutter_bridge.js`, compilată în `dist/bundle.js`) este
independentă de plugin: detectează `window.BlockbenchChannel.postMessage`
(webview_flutter) sau `window.flutter_inappwebview.callHandler`
(flutter_inappwebview).

* **Cerere** (Flutter → JS): `FlutterBridge.call({id, method, params})`
* **Răspuns** (JS → Flutter): `{type: 'response', id, ok, result | error}`
* **Evenimente** (JS → Flutter): `ready`, `edited`, `project_selected`,
  `project_created`, `project_closed`, `quick_save`
* **Fișiere salvate din UI**: `{type: 'export', name, file_type, savetype,
  encoding: 'text' | 'base64', data}`

Deschide pagina cu `?flutter=1` pentru ajustările de UI încă de la pornire.

## Rulare exemplu

```bash
cd flutter/blockbench_bridge/example
flutter create . --platforms=android,ios,macos   # generează scheletul nativ
# aplică configurarea per platformă de mai sus
flutter run
```

## Note și limitări

* Asset-urile web adaugă ~11 MB la aplicație (bundle-ul Blockbench + fonturi
  + CSS). Sursele map (`bundle.js.map`, 17 MB) nu sunt incluse.
* Un `BlockbenchView` per ecran; editorul suportă însă mai multe proiecte
  deschise simultan în tab-urile lui interne.
* Payload-urile mari (texturi 4K în ambele sensuri) sunt transmise ca base64
  prin canalul JS — funcționează, dar pentru fișiere de zeci de MB ia în
  calcul împărțirea pe bucăți.
* Funcțiile care țin de sistemul de fișiere desktop (Recent Projects,
  auto-backup pe disc) rămân dezactivate în modul web — starea se salvează
  prin `getModel()`/`onExport`.
