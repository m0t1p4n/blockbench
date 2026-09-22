// Flutter integration bridge
// Exposes window.FlutterBridge for embedding Blockbench inside a Flutter WebView.
// Communication model:
//  - Flutter -> JS: controller.runJavaScript("FlutterBridge.call('<json>')")
//    where the JSON payload is {id, method, params}. The response is posted back
//    asynchronously through the message channel as {type: 'response', id, ok, result|error}.
//  - JS -> Flutter: messages are posted as JSON strings through one of:
//      * window.BlockbenchChannel.postMessage(msg)   (webview_flutter JavaScriptChannel)
//      * window.flutter_inappwebview.callHandler('BlockbenchChannel', msg)   (flutter_inappwebview)
// All file exports (save actions triggered inside the Blockbench UI) are intercepted
// and forwarded to Flutter as {type: 'export'} messages instead of browser downloads.

function getChannel() {
	if (window.BlockbenchChannel && typeof window.BlockbenchChannel.postMessage == 'function') {
		return msg => window.BlockbenchChannel.postMessage(msg);
	}
	if (window.flutter_inappwebview && typeof window.flutter_inappwebview.callHandler == 'function') {
		return msg => window.flutter_inappwebview.callHandler('BlockbenchChannel', msg);
	}
	return null;
}

function post(type, data = {}) {
	let send = getChannel();
	if (!send) return false;
	try {
		send(JSON.stringify(Object.assign({type}, data)));
		return true;
	} catch (err) {
		console.error('FlutterBridge: failed to post message', err);
		return false;
	}
}

function blobToBase64(blob) {
	return new Promise((resolve, reject) => {
		let reader = new FileReader();
		reader.onload = () => resolve(reader.result.split(',')[1]);
		reader.onerror = reject;
		reader.readAsDataURL(blob);
	})
}

async function contentToPayload(content) {
	if (content instanceof Blob) {
		return {encoding: 'base64', data: await blobToBase64(content)};
	}
	if (typeof content == 'string' && content.startsWith('data:')) {
		let comma = content.indexOf(',');
		return {encoding: 'base64', mime: content.substring(5, content.indexOf(';')), data: content.substring(comma + 1)};
	}
	if (content instanceof Uint8Array || content instanceof ArrayBuffer) {
		return {encoding: 'base64', data: await blobToBase64(new Blob([content]))};
	}
	return {encoding: 'text', data: String(content)};
}

// Resolves texture / parent model requests against the maps provided by Flutter.
// Keys can be simple file names ("stone.png"), java links ("block/stone",
// "minecraft:block/stone") or full resource pack paths.
function createDataResolver(...maps) {
	let entries = [];
	for (let map of maps) {
		if (!map || typeof map != 'object') continue;
		for (let key in map) {
			// A texture entry may carry PBR channels; codecs that resolve
			// textures by path only ever want the color one.
			let value = map[key];
			let data = (value && typeof value == 'object') ? textureChannelsOf(value).color : value;
			if (data == undefined) continue;
			entries.push({key: normalizePath(key), data});
		}
	}
	function normalizePath(input) {
		return String(input).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^minecraft:/, '').toLowerCase();
	}
	function stripExtension(input) {
		return input.replace(/\.\w+$/, '');
	}
	return function resolve(request_path) {
		if (!request_path || !entries.length) return undefined;
		let p = normalizePath(request_path).replace(/\?\d+$/, '');
		let p_noext = stripExtension(p);
		// Exact and extension-less match
		for (let e of entries) {
			if (e.key == p || stripExtension(e.key) == p_noext) return e.data;
		}
		// Suffix match: requested path ends with the provided key
		for (let e of entries) {
			let key_noext = stripExtension(e.key);
			if (p.endsWith('/' + e.key) || p_noext.endsWith('/' + key_noext)) return e.data;
		}
		// Base name match
		let base = stripExtension(p.split('/').last());
		for (let e of entries) {
			if (stripExtension(e.key.split('/').last()) == base) return e.data;
		}
		return undefined;
	}
}

function detectFormat(name, model) {
	if (typeof name == 'string' && name.toLowerCase().endsWith('.bbmodel')) return 'project';
	if (model && typeof model == 'object') {
		if (model.meta && (model.meta.model_format || model.meta.format_version)) return 'project';
		if (model['minecraft:geometry']) return 'bedrock';
		if (Object.keys(model).some(key => key.startsWith('geometry.'))) return 'bedrock_old';
	}
	return 'java_block';
}

// What the host's own header needs to draw its back / forward buttons.
function historyState() {
	let history = (typeof Undo != 'undefined' && Undo.history) ? Undo.history : [];
	let index = (typeof Undo != 'undefined' && Undo.index) || 0;
	return {can_undo: index > 0, can_redo: index < history.length};
}

function postHistory() {
	post('history', historyState());
}

function projectInfo(project = Project) {
	if (!project) return {has_project: false};
	let info = {
		has_project: true,
		uuid: project.uuid,
		name: project.name || project.geometry_name || '',
		format: project.format ? project.format.id : null,
		saved: project.saved
	};
	if (silent_project_uuids.has(project.uuid)) info.placeholder = true;
	Object.assign(info, historyState());
	return info;
}

// --- Boot placeholder project ---------------------------------------------
// In embedded mode the user must never see the start/new-tab page: an empty
// placeholder project is opened at boot so the editor is visible immediately.
// It is closed automatically as soon as the first real model is loaded, and
// its events are not forwarded to Flutter (so hosts can wait for the real
// project).
const silent_project_uuids = new Set();
let placeholder_uuid = null;
let creating_placeholder = false;
let placeholder_disposal = null;

// Retiring the boot placeholder re-selects projects and resets the timeline,
// and it is scheduled on a timeout right after the real model opens — so
// anything that starts playback has to let it finish first, or it is a coin
// flip whether the clock survives. `placeholder_uuid` covers the window before
// the disposal runs, `placeholder_disposal` the async close itself.
function settlePlaceholder() {
	if (!placeholder_uuid && !placeholder_disposal) return Promise.resolve();
	return new Promise(resolve => {
		let attempts = 0;
		(function wait() {
			if ((!placeholder_uuid && !placeholder_disposal) || ++attempts > 40) {
				return resolve();
			}
			setTimeout(wait, 25);
		})();
	});
}

function ensurePlaceholderProject() {
	if (!FlutterBridge.embedded) return;
	if (ModelProject.all.length || placeholder_uuid) return;
	// The flag makes the event listeners silence the project while newProject
	// dispatches new_project/select_project during creation
	creating_placeholder = true;
	try {
		newProject(Formats.free || Formats[Object.keys(Formats)[0]]);
		if (Project) {
			placeholder_uuid = Project.uuid;
			silent_project_uuids.add(Project.uuid);
			Project.saved = true;
		}
	} finally {
		creating_placeholder = false;
	}
}
function disposePlaceholderProject() {
	if (!placeholder_uuid) return;
	let placeholder = ModelProject.all.find(p => p.uuid == placeholder_uuid);
	placeholder_uuid = null;
	if (!placeholder) return;
	if (placeholder == Project || !placeholder.saved) {
		// The placeholder became a real project (imported into / edited)
		silent_project_uuids.delete(placeholder.uuid);
		return;
	}
	// close() deselects before it re-selects the next project: a rejection
	// half-way through would strand the editor with no project at all, so it
	// must never go unhandled.
	placeholder_disposal = Promise.resolve(placeholder.close(true))
		.catch(err => {
			console.error('FlutterBridge: failed to close the boot placeholder', err);
			if (!Project && ModelProject.all.length) ModelProject.all[0].select();
		})
		.finally(() => {
			placeholder_disposal = null;
		});
}

function base64ToUint8Array(base64) {
	let binary = atob(base64);
	let bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// Creates a project texture from a data URL. TGA data URLs (which <img>
// can't display) are decoded through Blockbench's TGA codec onto the canvas.
// `options.channel` puts the texture on a PBR channel ('color' | 'mer' |
// 'normal' | 'height') of `options.group`.
async function addTextureFromDataURL(name, data_url, options = {}) {
	let texture = new Texture({name});
	if (options.group) texture.group = options.group.uuid;
	if (options.channel) texture.pbr_channel = options.channel;
	let is_tga = typeof data_url == 'string' && /^data:image\/(x-)?(tga|targa);base64,/i.test(data_url);
	if (is_tga) {
		texture.file_format = 'tga';
		let bytes = base64ToUint8Array(data_url.substring(data_url.indexOf(',') + 1));
		await Texture.file_formats.tga.decode(bytes, texture);
		texture.add(false).fillParticle();
	} else {
		texture.fromDataURL(data_url).add(false).fillParticle();
	}
	return texture;
}

// The PBR channels a texture entry of loadModel/addTexture may carry:
// {color: '<data url>', mer: '<data url>', normal: …, height: …}. A plain
// string is the color channel on its own.
const PBR_CHANNELS = ['color', 'normal', 'height', 'mer'];

function textureChannelsOf(value) {
	if (typeof value == 'string') return {color: value};
	if (!value || typeof value != 'object') return {};
	let channels = {};
	for (let channel of PBR_CHANNELS) {
		if (typeof value[channel] == 'string' && value[channel]) {
			channels[channel] = value[channel];
		}
	}
	return channels;
}

// Resolves once the texture's bitmap is in memory. Texture.load() only kicks
// the <img> off, and a material built before it decoded silently drops the
// MER maps (the group reads `mer_tex.width` and the canvas pixels).
//
// The image's own load event is no help: every Texture starts on the
// placeholder art, so it is already "loaded" — Blockbench setting the
// texture's size in its own handler is what says the real file arrived.
function waitForTextureLoad(texture) {
	return new Promise(resolve => {
		let attempts = 0;
		(function check() {
			// 5s cap: a broken texture must never hang the model load.
			if (!texture || (texture.width && texture.height) || ++attempts > 200) {
				return resolve();
			}
			setTimeout(check, 25);
		})();
	});
}

// Brings a preview scene up and resolves once it is really there — its config
// read and its skybox decoded — so the model shows in it from the first frame
// the host lets through, and the material is built against what it reflects
// rather than against an empty sky.
async function selectPreviewScene(id) {
	let scene = PreviewScene.scenes[id];
	if (!scene) return;
	if (PreviewScene.active !== scene) await scene.select();
	let cubemap = scene.cubemap;
	if (!cubemap) return;
	await new Promise(resolve => {
		let attempts = 0;
		(function check() {
			// The loader bumps the version once all six faces are in. 5s cap:
			// a skybox that fails to load must never hang the model load.
			if (cubemap.version > 0 || ++attempts > 200) return resolve();
			setTimeout(check, 25);
		})();
	});
}

// Adds one entry of loadModel's `textures` map. With more than the color
// channel the textures land in a material texture group, which is what makes
// Blockbench shade the model through a MeshStandardMaterial (metalness,
// emissive and roughness out of the MER map).
async function addTextureEntry(name, value) {
	let channels = textureChannelsOf(value);
	let channel_names = Object.keys(channels);
	if (!channel_names.length) return null;

	if (channel_names.length == 1 && channels.color) {
		return await addTextureFromDataURL(name, channels.color);
	}

	let group = new TextureGroup({name, is_material: true}).add(false);
	let base_name = name.replace(/\.\w+$/, '');
	let color_texture = null;
	let textures = [];
	for (let channel of PBR_CHANNELS) {
		if (!channels[channel]) continue;
		let texture_name = channel == 'color' ? name : `${base_name}_${channel}`;
		let texture = await addTextureFromDataURL(texture_name, channels[channel], {
			group,
			channel,
		});
		textures.push(texture);
		if (channel == 'color') color_texture = texture;
	}
	// The material reads the bitmaps, so every channel has to be decoded
	// before it is built.
	await Promise.all(textures.map(waitForTextureLoad));
	group.updateMaterial();
	return color_texture;
}

// All animations of the current project as one bedrock animation file (JSON
// text), or null when there are none or the format has no animation support.
function compileProjectAnimations() {
	if (!Format || !Format.animation_mode) return null;
	if (typeof Animation == 'undefined' || !Animation.all.length) return null;
	let codec = AnimationCodec.codecs.bedrock;
	if (!codec) return null;
	return compileJSON(codec.compileFile(Animation.all));
}

function getTextureList() {
	return Texture.all.map(texture => {
		let source = texture.getDataURL();
		if ((!source || !source.startsWith('data:')) && texture.canvas && texture.canvas.width) {
			source = texture.canvas.toDataURL('image/png', 1);
		}
		return {
			uuid: texture.uuid,
			name: texture.name,
			id: texture.id,
			folder: texture.folder,
			namespace: texture.namespace,
			particle: texture.particle,
			render_mode: texture.render_mode,
			pbr_channel: texture.pbr_channel,
			group: texture.group,
			width: texture.width,
			height: texture.height,
			source
		};
	});
}

// --- Chromeless preview mode ----------------------------------------------
// Turns the editor into a bare viewer: menu bar, tab bar, toolbars, mode
// selector, sidebars, panels and status bar are hidden and the 3D viewport
// takes the whole page. Only the orbit / zoom gestures stay live. Enabled
// with `?preview=1` on the URL or through the setPreviewMode bridge method.
let preview_mode = false;
let preview_context_menu_blocked = false;
let preview_resize_observer = null;
// Once the user has orbited or zoomed, the camera is theirs — auto-framing
// stops fighting them. Applies to the editor as much as to the preview.
let camera_owned_by_user = false;
let auto_frame_armed = false;
let camera_watchers_installed = false;
const PREVIEW_FRAME_MARGIN = 1.25;

const PREVIEW_STYLE = `
	body.flutter_preview {
		background-image: none;
		--menu-bar-height: 0px;
		--status-bar-height: 0px;
	}
	body.flutter_preview #page_wrapper {
		height: 100% !important;
		border: none !important;
		visibility: visible !important;
	}
	/* Whitelist the chain down to the canvas instead of naming the parts to
	   hide: title bar, dialogs, tab bar, start page, toolbars, sidebars,
	   panels, status bar, the mobile panel selector, the in-viewport menus and
	   the orbit gizmo all disappear at once — and a control nobody enumerated
	   can't leak through later. The last step matters because the viewport
	   overlays live in .single_canvas_wrapper > .preview, next to the canvas,
	   not as children of #preview. */
	body.flutter_preview > *:not(#page_wrapper),
	body.flutter_preview #page_wrapper > *:not(#work_screen),
	body.flutter_preview #work_screen > *:not(#center),
	body.flutter_preview #center > *:not(#preview),
	body.flutter_preview #preview > *:not(.single_canvas_wrapper):not(.split_screen_wrapper),
	body.flutter_preview #preview .preview > *:not(canvas) { display: none !important; }
	body.flutter_preview #work_screen {
		/* setStartScreen() writes an inline display on the work screen every
		   time Blockbench swaps between the start page and the editor — which
		   happens while the boot placeholder is retired for the real model.
		   The start page is hidden here, so letting it win would leave the
		   user staring at an empty page. */
		display: grid !important;
		grid-template-columns: 1fr !important;
		grid-template-rows: 1fr !important;
		grid-template-areas: "center" !important;
		min-height: 0 !important;
		height: 100% !important;
		flex: 1 1 auto !important;
	}
	/* The grid template above cannot be relied on: Blockbench's own mobile
	   rules set grid-template-columns/rows with !important from inside
	   @layer base, and a layered !important beats an unlayered one — which is
	   what this stylesheet is. On a touch device in landscape that left the
	   viewport in an auto-sized row, against which the percentage height
	   below is circular, so it collapsed to 0 and nothing was ever drawn.
	   Taking the viewport out of the grid flow sidesteps the fight entirely:
	   position/inset carry no !important anywhere in Blockbench, and
	   #work_screen is position: relative in every layout. */
	body.flutter_preview #center {
		position: absolute !important;
		/* An absolutely positioned child of a grid container is sized against
		   its *grid area*, not the container, whenever it keeps an explicit
		   placement — which would put it right back in the collapsed cell.
		   Dropping the placement makes #work_screen's padding box the
		   containing block. */
		grid-area: auto !important;
		inset: 0 !important;
		border-radius: 0 !important;
	}
	/* updateInterfacePanels() writes an inline height/visibility on the
	   viewport, sized around the docked panels — which no longer exist here. */
	body.flutter_preview #preview {
		height: 100% !important;
		visibility: visible !important;
	}
`;

// Everything the editor paints on top of the model — transform gizmo, pivot
// markers, locator anchors, bone helpers, selection outlines — is editing
// furniture rather than part of the entity. Strip it whenever a model lands.
function stripPreviewDecorations() {
	if (!preview_mode || !Project) return;
	try {
		Canvas.show_gizmos = false;
		Outliner.elements.forEach(element => {
			let is_helper = element instanceof Locator ||
				(element.getTypeBehavior && element.getTypeBehavior('hide_in_screenshot'));
			// The element's own visibility flag is what the preview controllers
			// read back, so it survives every canvas refresh.
			if (is_helper) element.visibility = false;
		});
		unselectAllElements();
		if (typeof Transformer != 'undefined') Transformer.detach();
		Canvas.updateVisibility();
		updateSelection();
		observePreviewSize();
		requestPreviewResize();
		reportPreviewViewport('load');
		// The WebView may still be settling — report again once it has.
		setTimeout(() => reportPreviewViewport('settled'), 1500);
	} catch (err) {
		console.warn('FlutterBridge: could not strip the preview decorations', err);
	}
}

// A blank preview looks identical whether the canvas is zero-sized, a modal is
// covering it, the scene is empty or the render loop is idling. Walk the whole
// layout chain so the host's console says which one it is.
function previewViewportInfo() {
	function box(id) {
		let node = document.getElementById(id);
		return node ? [node.clientWidth, node.clientHeight, getComputedStyle(node).display] : null;
	}
	let preview_node = document.getElementById('preview');
	let canvas = preview_node && preview_node.querySelector('canvas');
	let blackout = document.getElementById('blackout');
	return {
		window: [window.innerWidth, window.innerHeight],
		body: [document.body.clientWidth, document.body.clientHeight],
		page_wrapper: box('page_wrapper'),
		work_screen: box('work_screen'),
		center: box('center'),
		preview: box('preview'),
		canvas: canvas ? [canvas.width, canvas.height] : null,
		elements: Outliner.elements.length,
		dialog: (typeof open_dialog != 'undefined' && open_dialog) ? String(open_dialog) : null,
		blackout: blackout ? getComputedStyle(blackout).display : null,
		background_rendering: !!(settings.background_rendering && settings.background_rendering.value),
		focused: document.hasFocus()
	};
}

function reportPreviewViewport(tag) {
	console.log('FlutterBridge: preview viewport [' + tag + '] ' + JSON.stringify(previewViewportInfo()));
}

function applyPreviewChrome(enabled) {
	preview_mode = !!enabled;
	document.body.classList.toggle('flutter_preview', preview_mode);
	if (preview_mode && !document.getElementById('flutter_preview_style')) {
		let style = document.createElement('style');
		style.id = 'flutter_preview_style';
		style.textContent = PREVIEW_STYLE;
		document.head.appendChild(style);
	}
	if (preview_mode && !preview_context_menu_blocked) {
		preview_context_menu_blocked = true;
		// Right click / long press must not reach the editor's context menus
		document.addEventListener('contextmenu', event => {
			if (!preview_mode) return;
			event.preventDefault();
			event.stopPropagation();
		}, true);
	}
	if (preview_mode && typeof Canvas != 'undefined') Canvas.show_gizmos = false;
	if (preview_mode && typeof settings != 'undefined' && settings.background_rendering) {
		// A WebView rarely holds document focus, and the render loop skips
		// every frame while unfocused unless background rendering is on.
		if (!settings.background_rendering.value) settings.background_rendering.set(true);
	}
	// The canvas keeps the size it had while the bars were still laid out
	setTimeout(() => {
		observePreviewSize();
		requestPreviewResize();
	}, 0);
}

function requestPreviewResize() {
	try {
		resizeWindow();
	} catch (err) {
		console.warn('FlutterBridge: preview resize failed', err);
	}
}

// Auto-framing, shared by the chromeless preview and the Skin / Model /
// Animation editors — the editor viewport is smaller (panels, toolbars) and
// changes size when modes switch, so it needs the same treatment.
function installCameraWatchers() {
	if (camera_watchers_installed) return;
	camera_watchers_installed = true;

	// The first deliberate camera move hands control to the user for good
	document.addEventListener('pointerdown', event => {
		if (event.target && event.target.closest && event.target.closest('#preview')) {
			camera_owned_by_user = true;
		}
	}, true);
	document.addEventListener('wheel', () => {
		camera_owned_by_user = true;
	}, {capture: true, passive: true});

	// Panels opening, a mode switch or the WebView finally handing over its
	// real size all change the aspect ratio the framing was solved for.
	Blockbench.on('resize_window', () => reframeIfUntouched());
}

function reframeIfUntouched() {
	if (!auto_frame_armed || camera_owned_by_user) return;
	if (typeof Project == 'undefined' || !Project) return;
	try {
		frameModelInView(PREVIEW_FRAME_MARGIN);
	} catch (err) {
		console.warn('FlutterBridge: could not frame the model', err);
	}
}

// A WebView commonly lays its page out only after Blockbench has already
// measured the viewport — the renderer then keeps the zero-sized canvas it
// booted with and the scene never shows up, with no error anywhere. Nothing
// in preview mode (no panels, no mode switches) would ever trigger another
// resize, so watch the viewport box itself.
function observePreviewSize() {
	if (preview_resize_observer || typeof ResizeObserver == 'undefined') return;
	let node = document.getElementById('preview');
	if (!node) return;
	preview_resize_observer = new ResizeObserver(() => requestPreviewResize());
	preview_resize_observer.observe(node);
}

// Vanilla entities ship a bundle of animations; the preview picks the one
// that reads as "the entity standing there being itself".
const PREVIEW_ANIMATION_PRIORITY = ['idle', 'look', 'walk', 'move', 'ground'];

// World-space bounding box of the model itself — the helper objects hidden by
// stripPreviewDecorations() are skipped, so locators and bone markers can't
// inflate it.
function modelBoundingBox() {
	if (typeof Canvas == 'undefined' || !Canvas.scene) return null;
	Canvas.scene.updateMatrixWorld(true);
	let box = new THREE.Box3();
	let found = false;
	Outliner.elements.forEach(element => {
		if (element.visibility === false) return;
		let mesh = element.mesh;
		if (!mesh || !mesh.geometry) return;
		box.expandByObject(mesh);
		found = true;
	});
	return found && !box.isEmpty() ? box : null;
}

// Turns the camera to look at the model from the south (+Z), level with its
// centre — straight onto the face a flat texture's plane carries it on.
function faceCameraSouth() {
	let preview = typeof Preview != 'undefined' && Preview.selected;
	if (!preview || !preview.controls) return;
	let box = modelBoundingBox();
	let target = box ? box.getCenter(new THREE.Vector3()) : preview.controls.target.clone();
	let distance = preview.camera.position.distanceTo(preview.controls.target) || 64;
	preview.camera.position.set(target.x, target.y, target.z + distance);
	preview.controls.target.copy(target);
	preview.controls.update();
}

// Points the camera at the model's centre and pulls it back just far enough to
// hold the whole model, so a chicken and an ender dragon both fill the same
// share of the viewport. The viewing angle is kept as-is.
function frameModelInView(margin) {
	let preview = typeof Preview != 'undefined' && Preview.selected;
	if (!preview || !preview.controls) return null;
	let box = modelBoundingBox();
	if (!box) return null;

	let center = box.getCenter(new THREE.Vector3());
	let radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 0.5);
	let camera = preview.camera;

	let direction = new THREE.Vector3().subVectors(camera.position, preview.controls.target);
	// A degenerate direction would collapse the camera onto the model
	if (direction.lengthSq() < 1e-6) direction.set(1, 0.75, 1);
	direction.normalize();

	let distance;
	if (preview.isOrtho) {
		let view = Math.min(
			Math.abs(camera.top - camera.bottom),
			Math.abs(camera.right - camera.left)
		);
		camera.zoom = view / (radius * 2 * margin);
		distance = Math.max(radius * 4, 100);
	} else {
		// Solve for the exact distance at which every corner of the box still
		// falls inside both fields of view. Fitting the bounding sphere
		// instead would be safe but slack, and slack differs with shape — a
		// cube would end up noticeably larger on screen than a tall mob,
		// which is the inconsistency this is here to remove.
		let vertical_fov = camera.fov * Math.PI / 180;
		let horizontal_fov = 2 * Math.atan(Math.tan(vertical_fov / 2) * (camera.aspect || 1));
		let tan_h = Math.tan(horizontal_fov / 2);
		let tan_v = Math.tan(vertical_fov / 2);

		// Camera basis: +Z runs from the model back towards the camera
		let z_axis = direction.clone();
		let x_axis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), z_axis);
		if (x_axis.lengthSq() < 1e-6) x_axis.set(1, 0, 0);
		x_axis.normalize();
		let y_axis = new THREE.Vector3().crossVectors(z_axis, x_axis).normalize();

		distance = 0;
		let corner = new THREE.Vector3();
		for (let i = 0; i < 8; i++) {
			corner.set(
				i & 1 ? box.max.x : box.min.x,
				i & 2 ? box.max.y : box.min.y,
				i & 4 ? box.max.z : box.min.z
			).sub(center);
			let depth = corner.dot(z_axis);
			distance = Math.max(
				distance,
				depth + Math.abs(corner.dot(x_axis)) / tan_h,
				depth + Math.abs(corner.dot(y_axis)) / tan_v
			);
		}
		distance *= margin;
	}
	distance = Math.clamp(
		distance,
		preview.controls.minDistance + 0.01,
		preview.controls.maxDistance - 1
	);

	preview.controls.target.copy(center);
	camera.position.copy(center).addScaledVector(direction, distance);
	camera.lookAt(center);
	camera.updateProjectionMatrix();
	preview.controls.updateSceneScale?.();
	preview.updateProjection?.();
	return {center: center.toArray(), radius, distance};
}

// Resolves true once the timeline clock has actually moved, false if it hasn't
// after a handful of frames.
function timelineIsAdvancing(timeout = 400) {
	return new Promise(resolve => {
		let start_time = Timeline.time;
		let deadline = performance.now() + timeout;
		(function check() {
			if (!Timeline.playing) return resolve(false);
			if (Timeline.time !== start_time) return resolve(true);
			if (performance.now() > deadline) return resolve(false);
			requestAnimationFrame(check);
		})();
	});
}

function pickPreviewAnimation() {
	if (typeof Animation == 'undefined' || !Animation.all.length) return null;
	for (let key of PREVIEW_ANIMATION_PRIORITY) {
		let match = Animation.all.find(a => a.name && a.name.toLowerCase().includes(key));
		if (match) return match;
	}
	return Animation.all[0];
}

const BridgeMethods = {
	ping() {
		return {
			version: Blockbench.version,
			setup_successful: !!Blockbench.setup_successful,
			formats: Object.keys(Formats),
			codecs: Object.keys(Codecs)
		};
	},
	getState() {
		return Object.assign(projectInfo(), {
			open_projects: ModelProject.all.map(project => projectInfo(project))
		});
	},
	newProject(params = {}) {
		let format = params.format || 'java_block';
		if (!Formats[format]) throw new Error(`Unknown format "${format}"`);
		newProject(Formats[format]);
		return projectInfo();
	},
	// params: {
	//   name: 'stone.json',            file name, used for format detection and project name
	//   format: 'auto' | 'java_block' | 'bedrock' | 'bedrock_old' | 'project',
	//   model: '<file content as JSON text>',
	//   textures: {'block/stone': 'data:image/png;base64,...'},   optional
	//   files: {'block/cube_all.json': '<json text>'},            optional, parent models etc.
	//   animations: {'entity.animation.json': '<json text>'},     optional, bedrock animation files
	//   mode: 'edit' | 'paint' | 'animate' | 'display',           optional, mode to open in
	//   material: false,               open in the material (PBR) view mode
	//   preview_scene: 'minecraft_plains',   environment the material reflects
	//   view: 'south',                 open looking at the model from the south, straight on
	//   import_to_current_project: false
	// }
	async loadModel(params = {}) {
		if (typeof params.model != 'string' || !params.model.length) {
			throw new Error('loadModel: params.model must be the model file content as a string');
		}
		let name = params.name || 'model.json';
		let model = autoParseJSON(params.model, {file_path: name});
		if (!model) throw new Error('loadModel: model content is not valid JSON');

		let format = (!params.format || params.format == 'auto') ? detectFormat(name, model) : params.format;
		let resolver = createDataResolver(params.textures, params.files);
		let load_args = {import_to_current_project: !!params.import_to_current_project, externalDataLoader: resolver};

		if (format == 'project' || format == 'bbmodel') {
			Codecs.project.load(model, {path: name, name, no_file: true});

		} else if (format == 'java_block') {
			// Fake a resource pack location so relative java texture links resolve through the resolver
			let file_path = 'assets/minecraft/models/' + name.replace(/^.*[\\\/]/, '');
			Codecs.java_block.load(model, {path: file_path, name, no_file: true}, load_args);

		} else if (Codecs[format]) {
			Codecs[format].load(model, {path: name, name, no_file: true}, load_args);

		} else {
			throw new Error(`Unknown format "${format}"`);
		}

		// Formats that don't reference textures from within the model file (e.g. bedrock):
		// add any provided textures that were not consumed by the codec
		if (params.textures && Texture.all.length == 0) {
			for (let key in params.textures) {
				let texture_name = key.split(/[\\\/]/).last();
				if (!texture_name.includes('.')) texture_name += '.png';
				await addTextureEntry(texture_name, params.textures[key]);
			}
			if (Texture.all.length) Texture.all[0].select();
		}
		// Bedrock animation files
		if (params.animations && Format.animation_mode && AnimationCodec.codecs.bedrock) {
			for (let file_name in params.animations) {
				try {
					AnimationCodec.codecs.bedrock.loadFile({
						path: file_name,
						content: params.animations[file_name]
					}, undefined);
				} catch (err) {
					console.error(`FlutterBridge: failed to load animation file "${file_name}"`, err);
				}
			}
		}
		// The codec opened the model in a project of its own, and the boot
		// placeholder is retired right after: closing it re-selects, which
		// puts the default mode, view and camera back. Wait it out, and make
		// sure the model is the project on screen before its mode, material
		// and camera are set below.
		let loaded = Project;
		await settlePlaceholder();
		if (loaded && Project !== loaded && ModelProject.all.includes(loaded)) {
			loaded.select();
		}
		if (Project) {
			if (params.name && !Project.name) Project.name = name.replace(/\.\w+$/, '');
			Project.saved = true;
			// When importing into the boot placeholder, it becomes a real project
			if (silent_project_uuids.has(Project.uuid)) {
				silent_project_uuids.delete(Project.uuid);
				if (placeholder_uuid == Project.uuid) placeholder_uuid = null;
			}
		}
		Canvas.updateAll();
		// The requested mode is a preference, not a requirement: a mode the
		// format doesn't support must never fail the load — the model is
		// already in the editor at this point.
		if (params.mode) {
			try {
				BridgeMethods.setMode({mode: params.mode});
			} catch (err) {
				console.warn(`FlutterBridge: could not open in mode "${params.mode}"`, err);
			}
		}
		stripPreviewDecorations();
		// A material group only shows through in the material view mode, and
		// its reflections need an environment (the preview scene). Both are
		// opt-in: `material: true` opens the model shaded, otherwise the MER
		// map rides along unused until setMaterialView turns it on.
		//
		// It runs after the mode switch on purpose — that re-applies the
		// project's own view mode, which would drop the material again.
		if (params.material && TextureGroup.all.find(group => group.is_material)) {
			let scene = params.preview_scene || 'minecraft_plains';
			await selectPreviewScene(scene);
			setMaterialViewMode(true, scene);
			setTimeout(() => setMaterialViewMode(true, scene), 60);
		}
		// A flat texture reads best straight on — the three-quarter view
		// from above shows it skewed, or its back. The user turns it from
		// there; the framing below keeps whichever angle the camera has.
		if (params.view == 'south') faceCameraSouth();
		// Centre and scale the entity — in the editors as much as in the
		// preview. A new model is framed again even if the user had moved the
		// camera around the previous one. Runs after setMode: switching to
		// paint or animate changes the viewport size the framing solves for.
		camera_owned_by_user = false;
		auto_frame_armed = true;
		installCameraWatchers();
		reframeIfUntouched();
		// Panels that a mode switch opens (the timeline in animate mode) lay
		// out asynchronously, which changes the viewport after the first pass.
		setTimeout(reframeIfUntouched, 120);
		let info = Object.assign(projectInfo(), {
			textures: Texture.all.length,
			animations: (typeof Animation != 'undefined' && Animation.all) ? Animation.all.length : 0,
			mode: Modes.selected ? Modes.selected.id : null
		});
		// Guaranteed signal for hosts that wait for the real model to appear
		post('project_selected', info);
		return info;
	},
	// params: {mode: 'edit' | 'paint' | 'animate' | 'display'}
	setMode(params = {}) {
		let mode = Modes.options[params.mode];
		if (!mode) throw new Error(`Unknown mode "${params.mode}"`);
		if (!Condition(mode.condition)) {
			throw new Error(`Mode "${params.mode}" is not available in this format`);
		}
		if (params.mode == 'paint' && !Texture.selected && Texture.all.length) {
			Texture.all[0].select();
		}
		if (params.mode == 'animate' && typeof Animation != 'undefined' && Animation.all.length && !Animation.selected) {
			Animation.all[0].select();
		}
		mode.select();
		return {mode: Modes.selected ? Modes.selected.id : null};
	},
	// params: {name: 'stone.png', data: 'data:image/png;base64,...' (PNG or TGA)}
	// params: {
	//   name: 'zombie.png',
	//   data: 'data:image/png;base64,...'   or  {color, mer, normal, height}
	// }
	async addTexture(params = {}) {
		if (!Project) throw new Error('No open project');
		let channels = textureChannelsOf(params.data);
		if (!Object.keys(channels).length) {
			throw new Error('addTexture: params.data must be a data URL or a channel map');
		}
		Undo.initEdit({textures: []});
		let texture = await addTextureEntry(params.name || 'texture.png', params.data);
		Undo.finishEdit('Add texture via Flutter bridge', {textures: [texture]});
		return texture ? {uuid: texture.uuid, name: texture.name} : {added: false};
	},
	// Turns the material (PBR) view mode on or off — the same switch the
	// viewport's Vibrant Visuals toggle flips, for hosts that want to drive
	// it from outside. Without a scene it comes back in the one it was last in.
	// params: {enabled: true, scene: 'minecraft_plains'}
	async setMaterialView(params = {}) {
		let enabled = params.enabled !== false;
		if (enabled && params.scene) await selectPreviewScene(params.scene);
		let applied = setMaterialViewMode(enabled, params.scene);
		return {enabled: applied, view_mode: Project ? Project.view_mode : null};
	},
	// params: {codec: 'auto' | codec id, include_textures: true, mark_saved: false}
	async getModel(params = {}) {
		if (!Project) throw new Error('No open project');
		let codec;
		if (!params.codec || params.codec == 'auto') {
			codec = (Format && Format.codec) || Codecs.project;
		} else {
			codec = Codecs[params.codec == 'bbmodel' ? 'project' : params.codec];
		}
		if (!codec) throw new Error(`Unknown codec "${params.codec}"`);
		let content = await codec.compile();
		if (typeof content != 'string') content = JSON.stringify(content);
		let result = {
			name: Project.name || Project.geometry_name || 'model',
			format: Format ? Format.id : null,
			codec: codec.id,
			extension: codec.extension || 'json',
			content
		};
		if (params.include_textures !== false) {
			result.textures = getTextureList();
		}
		if (params.include_animations !== false) {
			result.animations = compileProjectAnimations();
		}
		if (params.mark_saved) Project.saved = true;
		return result;
	},
	getTextures() {
		if (!Project) throw new Error('No open project');
		return {textures: getTextureList()};
	},
	// The project's animations compiled as one bedrock animation file (JSON
	// text), or null when the project has none.
	getAnimations() {
		if (!Project) throw new Error('No open project');
		return {animations: compileProjectAnimations()};
	},
	// params: {crop: true, width, height, plain: true}
	// `plain` (the default) takes the model alone: the material view's scene
	// fills the whole frame — nothing transparent left for the crop to trim —
	// so it is switched off for the shot and back on right after, all within
	// one frame, never painted.
	getScreenshot(params = {}) {
		return new Promise(resolve => {
			if (!Project) throw new Error('No open project');
			let scene = params.plain !== false && Project.view_mode == 'material'
				? ((PreviewScene.active && PreviewScene.active.id) || 'studio')
				: null;
			if (scene) setMaterialViewMode(false);
			Screencam.screenshotPreview(Preview.selected, {crop: params.crop !== false, width: params.width, height: params.height}, data => {
				if (scene) setMaterialViewMode(true, scene);
				resolve({data});
			});
		});
	},
	markSaved(params = {}) {
		if (!Project) throw new Error('No open project');
		Project.saved = params.saved !== false;
		return projectInfo();
	},
	selectProject(params = {}) {
		let project = ModelProject.all.find(p => p.uuid == params.uuid);
		if (!project) throw new Error(`No project with UUID "${params.uuid}"`);
		project.select();
		return projectInfo();
	},
	async closeProject(params = {}) {
		if (!Project) return {has_project: false};
		await Project.close(params.force !== false);
		return {closed: true};
	},
	undo() {
		Undo.undo();
		return projectInfo();
	},
	redo() {
		Undo.redo();
		return projectInfo();
	},
	triggerAction(params = {}) {
		let action = BarItems[params.id];
		if (!action) throw new Error(`Unknown action "${params.id}"`);
		action.trigger();
		return {triggered: params.id};
	},
	// params: {enabled: true}
	setPreviewMode(params = {}) {
		applyPreviewChrome(params.enabled !== false);
		return {preview: preview_mode};
	},
	// Centres the model and scales it to a consistent share of the viewport.
	// params: {margin: 1.25}   — higher leaves more air around the model
	frameModel(params = {}) {
		if (!Project) throw new Error('No open project');
		let margin = typeof params.margin == 'number' && params.margin > 0
			? params.margin
			: PREVIEW_FRAME_MARGIN;
		let result = frameModelInView(margin);
		if (!result) return {framed: false};
		return Object.assign({framed: true}, result);
	},
	// Starts an animation on loop. Playback only runs while the animate mode
	// is active, so the mode is switched here — in preview mode its UI is
	// hidden anyway.
	// params: {name: 'animation.zombie.walk', loop: true, speed: 100}
	async playAnimation(params = {}) {
		// Never start on top of the boot placeholder being retired
		await settlePlaceholder();
		if (!Project) throw new Error('No open project');
		if (typeof Animation == 'undefined' || !Animation.all.length) {
			return {playing: false, animation: null};
		}
		let animation = params.name
			? Animation.all.find(a => a.name == params.name) ||
				Animation.all.find(a => a.name && a.name.includes(params.name))
			: pickPreviewAnimation();
		if (!animation) return {playing: false, animation: null};

		let animate_mode = Modes.options.animate;
		if (!animate_mode || !Condition(animate_mode.condition)) {
			throw new Error('This format has no animation mode');
		}
		if (Modes.selected != animate_mode) animate_mode.select();

		animation.select();
		if (params.loop !== false) animation.loop = 'loop';
		if (typeof params.speed == 'number') Timeline.playback_speed = params.speed;
		Timeline.setTime(0);
		Timeline.start();
		// Selecting an animation re-attaches the bone gizmos
		stripPreviewDecorations();

		// `Timeline.playing` only means the flag is set — the clock is driven
		// by the render loop, and anything that resets the project in the
		// meantime leaves playback frozen at 0 while still looking started.
		// Confirm it is really advancing, and re-arm once if it isn't.
		let advanced = await timelineIsAdvancing();
		if (!advanced) {
			Timeline.setTime(0);
			Timeline.start();
			advanced = await timelineIsAdvancing();
		}
		return {
			playing: !!Timeline.playing,
			advancing: advanced,
			animation: animation.name
		};
	},
	pauseAnimation() {
		if (typeof Timeline != 'undefined' && Timeline.playing) Timeline.pause();
		return {playing: false};
	}
};

export const FlutterBridge = {
	get embedded() {
		return !!getChannel() || !!Blockbench.queries.flutter;
	},
	post,
	// Entry point for calls from Flutter. Accepts a JSON string or object
	// {id, method, params}; the result is posted back as a 'response' message.
	call(request) {
		let id = null;
		try {
			if (typeof request == 'string') request = JSON.parse(request);
			id = request.id ?? null;
			let method = BridgeMethods[request.method];
			if (!method) throw new Error(`Unknown bridge method "${request.method}"`);
			Promise.resolve(method(request.params || {})).then(result => {
				post('response', {id, ok: true, result: result ?? null});
			}).catch(err => {
				console.error('FlutterBridge:', err);
				post('response', {id, ok: false, error: err ? (err.message || String(err)) : 'Unknown error'});
			});
		} catch (err) {
			console.error('FlutterBridge:', err);
			post('response', {id, ok: false, error: err ? (err.message || String(err)) : 'Unknown error'});
		}
		return true;
	},
	methods: BridgeMethods
};

// Intercept file exports: every save action inside the Blockbench UI ends up in
// Blockbench.export(). When a Flutter channel is connected, forward the file to
// Flutter instead of triggering a browser download.
const original_export = Blockbench.export;
Blockbench.export = function(options = {}, callback) {
	if (isApp || !getChannel()) {
		return original_export.call(Blockbench, options, callback);
	}
	let file_name = options.name || 'file';
	let extension = pathToExtension(file_name);
	if (options.extensions instanceof Array && !options.extensions.includes(extension) && options.extensions[0]) {
		file_name += '.' + options.extensions[0];
	}
	let savetype = typeof options.savetype == 'function' ? options.savetype(file_name) : options.savetype;
	contentToPayload(options.content).then(payload => {
		post('export', Object.assign({
			name: file_name,
			file_type: options.type || '',
			savetype: savetype || 'text',
			resource_id: options.resource_id || ''
		}, payload));
		if (typeof callback == 'function') callback(file_name);
	});
}
Blockbench.exportFile = Blockbench.export;

// Forward relevant editor events to Flutter
let edit_timeout = null;
Blockbench.on('finished_edit', () => {
	clearTimeout(edit_timeout);
	edit_timeout = setTimeout(() => {
		post('edited', projectInfo());
	}, 80);
	postHistory();
});
// The host draws the back / forward buttons, so it has to hear about every
// move of the undo stack — its own calls included.
Blockbench.on('undo', postHistory);
Blockbench.on('redo', postHistory);
Blockbench.on('select_project', ({project}) => {
	if (creating_placeholder) {
		if (project) silent_project_uuids.add(project.uuid);
		return;
	}
	if (!project || silent_project_uuids.has(project.uuid) || project.is_new_tab) return;
	// A real project appeared: retire the boot placeholder once the load settled
	if (placeholder_uuid) setTimeout(disposePlaceholderProject, 0);
	post('project_selected', projectInfo(project));
});
Blockbench.on('new_project', ({project}) => {
	if (creating_placeholder) {
		if (project) silent_project_uuids.add(project.uuid);
		return;
	}
	if (!project || silent_project_uuids.has(project.uuid)) return;
	if (placeholder_uuid) setTimeout(disposePlaceholderProject, 0);
	post('project_created', projectInfo(project));
});
Blockbench.on('close_project', ({project} = {}) => {
	let was_silent = project && silent_project_uuids.has(project.uuid);
	if (project) silent_project_uuids.delete(project.uuid);
	// Never leave the user on the empty new-tab page in embedded mode
	setTimeout(ensurePlaceholderProject, 0);
	if (was_silent) return;
	post('project_closed', {});
});
Blockbench.on('quick_save_model', () => {
	post('quick_save', projectInfo());
});

// Adjust the UI when running inside a Flutter WebView: no start screen, no
// quick setup / onboarding, no "new tab" home page — only the editor itself.
// The host app is expected to open a model through the bridge right away.
function applyEmbeddedTweaks() {
	if (!FlutterBridge.embedded) return;
	// The host app ships the Minecraft assets it hands the editor, and its own
	// terms are where they are agreed to — the preview scenes are no different.
	// The EULA dialog would ask a second time, and in the chromeless preview,
	// where every dialog is hidden, nobody could answer it: the scene would
	// never load.
	if (window.MinecraftEULA) MinecraftEULA.promptUser = async () => true;
	// `?preview=1` strips the editor down to the bare viewport
	if (Blockbench.queries && Blockbench.queries.preview && !preview_mode) {
		applyPreviewChrome(true);
	}
	if (document.getElementById('flutter_embedded_style')) return;
	document.body.classList.add('flutter_embedded');
	let style = document.createElement('style');
	style.id = 'flutter_embedded_style';
	style.textContent = `
		body.flutter_embedded #start_screen { display: none !important; }
		body.flutter_embedded #new_tab_button { display: none !important; }
		body.flutter_embedded .project_tab.new_tab { display: none !important; }
		body.flutter_embedded #title_bar_home_button { display: none !important; }
		body.flutter_embedded #web_download_button { display: none !important; }
		/* The mobile header (menu, search, undo/redo, mode switcher) is the
		   host app's business — it draws those in its own page header and
		   drives them over the bridge. */
		body.flutter_embedded > header { display: none !important; }
	`;
	document.head.appendChild(style);
}
applyEmbeddedTweaks();

function announceReady() {
	applyEmbeddedTweaks();
	// Open the editor right away — the user must never see the start page
	ensurePlaceholderProject();
	post('ready', {
		version: Blockbench.version,
		setup_successful: !!Blockbench.setup_successful
	});
}
announceReady();
// flutter_inappwebview registers its handler after page load
window.addEventListener('flutterInAppWebViewPlatformReady', announceReady);

window.FlutterBridge = FlutterBridge;
