import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { defaults, renderDesign } from './render';
import { decodePacket, WIDTH, HEIGHT } from './packet.mjs';
import type { State, Display, Preset, Design, Ink, Job } from './types';
import './style.css';
import './preparation.css';
import { api, uid, uploadPacket } from './api';
import { HealthPage, AutomationsPage, ControllerSettings, BackupControls } from './features';
import { LayoutEditor } from './layout';
import { LiveDataPage } from './live';
import { HistoryPage } from './history';
import { MqttSettings } from './mqtt';
import { FirmwareUpdates } from './firmware';
import { ImagePreparation } from './image-prep';

type Page = 'Displays' | 'Saved screens' | 'Automations' | 'Diagnostics' | 'Live data' | 'Activity' | 'History' | 'Settings';
const paths: Record<string, React.ReactNode> = {
  displays: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></>,
  library: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  activity: <><path d="M3 12h4l3-8 4 16 3-8h4"/></>,
  settings: <><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/></>,
  plus: <path d="M12 5v14M5 12h14"/>, arrow: <path d="m9 5 7 7-7 7"/>, back: <path d="m14 5-7 7 7 7"/>,
  send: <><path d="m3 3 19 9-19 9 4-9-4-9Zm4 9h15"/></>,
  check: <path d="m5 12 4 4L19 6"/>, close: <path d="m6 6 12 12M6 18 18 6"/>,
  wifi: <><path d="M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0m-9 4a5 5 0 0 1 6 0"/><circle cx="12" cy="20" r=".6"/></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/></>,
  edit: <><path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></>,
  book: <><path d="M4 3h12l4 4v14H4V3Zm12 0v5h4M8 12h8m-8 4h6"/></>,
};
function Icon({ name, size = 20 }: { name: string; size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.displays}</svg>; }
const imageCache = new Map<string, Promise<Uint8ClampedArray<ArrayBuffer>>>();
function getImage(asset: string) {
  if (!imageCache.has(asset)) imageCache.set(asset, fetch('/api/v1/assets/' + encodeURIComponent(asset))
    .then(response => { if (!response.ok) throw new Error('Image unavailable'); return response.arrayBuffer(); })
    .then(buffer => decodePacket(new Uint8Array(buffer))));
  return imageCache.get(asset)!;
}
function Preview({ preset, large = false }: { preset?: Preset; large?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const canvas = ref.current!; canvas.width = WIDTH; canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, WIDTH, HEIGHT);
    if (!preset) {
      ctx.fillStyle = '#c7cac2'; ctx.textAlign = 'center'; ctx.font = '500 30px Arial';
      ctx.fillText('Ready for something new.', WIDTH / 2, HEIGHT / 2 + 10); return;
    }
    let live = true; setFailed(false);
    getImage(preset.asset).then(pixels => { if (live) ctx.putImageData(new ImageData(pixels, WIDTH, HEIGHT), 0, 0); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [preset?.asset]);
  return <div className={'paper-preview' + (large ? ' large' : '')}><canvas ref={ref} aria-label={preset ? `Preview of ${preset.name}` : 'Display preview'} />{failed && <span className="preview-note">Preview unavailable</span>}</div>;
}
function Badge({ state }: { state: string }) { return <span className={'badge ' + state}><span/>{({ completed: 'Acknowledged', sending: 'Sending', queued: 'Queued', failed: 'Needs attention', cancelled: 'Cancelled', retrying: 'Retry scheduled' } as Record<string, string>)[state] || state}</span>; }
function Modal({ title, children, close }: { title: string; children: React.ReactNode; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.querySelector<HTMLElement>('input,button,select')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') {
        const nodes = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,textarea,a[href]');
        if (!nodes?.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return <div className="modal-shade" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}><div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
    <div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={close}><Icon name="close"/></button></div>{children}</div></div>;
}
function DeviceDialog({ device, nextId, close, save }: { device?: Display; nextId: number; close: () => void; save: (device: Display) => Promise<void> }) {
  const [form, setForm] = useState<Display>(device || { name: '', serial: '', id: nextId, palette: 'bwy', channel: 0, network: 1, wake_channel: 4 });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const update = (key: keyof Display, value: unknown) => setForm(previous => ({ ...previous, [key]: value }));
  return <Modal title={device ? 'Display settings' : 'Add a display'} close={close}><form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { await save(form); close(); } catch (e) { setError((e as Error).message); setBusy(false); } }}>
    <p className="muted">Give your screen a name. Its serial number is printed on the back.</p>
    <label>Display name<input required maxLength={40} placeholder="Kitchen display" value={form.name} onChange={e => update('name', e.target.value)}/></label>
    <label>Serial number<input required pattern="[A-Z]{2}[0-9]{8}[BC]" placeholder="JM00000000B" value={form.serial} disabled={!!device} onChange={e => update('serial', e.target.value.toUpperCase())}/></label>
    <label>Display colors<select value={form.palette} onChange={e => update('palette', e.target.value)}><option value="bwy">Black, white & yellow</option><option value="bwr">Black, white & red</option></select></label>
    <details><summary>Advanced radio settings</summary><div className="form-grid">
      {([['id', 'Display ID', 1, 65534], ['channel', 'Channel', 0, 72], ['network', 'Network ID', 1, 253], ['wake_channel', 'Wake-up channel', 0, 72]] as const).map(([key, title, min, max]) => <label key={key}>{title}<input type="number" min={min} max={max} required value={form[key]} onChange={e => update(key, Number(e.target.value))}/></label>)}
    </div><p className="small muted">These must match your tag's radio configuration. Your existing working settings are preserved.</p></details>
    {error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button secondary" onClick={close}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save display'}</button></div>
  </form></Modal>;
}
function Editor({ preset, devices, onClose, onSaved }: { preset?: Preset; devices: Display[]; onClose: () => void; onSaved: (id: string, serial?: string) => Promise<void> }) {
  const [design, setDesign] = useState<Design>(preset ? { ...defaults, ...preset } : defaults);
  const [name, setName] = useState(preset?.name || '');
  const [target, setTarget] = useState(devices[0]?.serial || '');
  const [image, setImage] = useState<CanvasImageSource | null>(null);
  const [preparingImage,setPreparingImage] = useState<CanvasImageSource|null>(null);
  const [layerImages,setLayerImages] = useState<Record<string,CanvasImageSource>>({});
  const [overflow, setOverflow] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null), upload = useRef<HTMLInputElement>(null);
  const update = <K extends keyof Design>(key: K, value: Design[K]) => setDesign(previous => ({ ...previous, [key]: value }));
  useEffect(() => { if (canvas.current) setOverflow(renderDesign(canvas.current, design, image, layerImages).overflow); }, [design, image, layerImages]);
  useEffect(() => {
    for (const layer of preset?.elements || []) if (layer.type === 'image' && layer.asset) getImage(layer.asset).then(pixels => { const source=document.createElement('canvas'); source.width=WIDTH; source.height=HEIGHT; source.getContext('2d')!.putImageData(new ImageData(pixels,WIDTH,HEIGHT),0,0); setLayerImages(previous=>({...previous,[layer.id]:source})); }).catch(()=>setError('Unable to load a layer image.'));
    if (preset?.kind === 'image') getImage(preset.asset).then(pixels => {
      const source = document.createElement('canvas'); source.width = WIDTH; source.height = HEIGHT;
      source.getContext('2d')!.putImageData(new ImageData(pixels, WIDTH, HEIGHT), 0, 0); setImage(source);
    }).catch(() => setError('Unable to load the saved image. Upload it again to edit this screen.'));
  }, []);
  async function save(send: boolean) {
    if (design.kind === 'image' && !image) { setError('Choose an image first.'); return; }
    if (design.kind === 'text' && (!design.text.trim() || design.color === design.background)) { setError('Enter a message and choose different text and paper colors.'); return; }
    if (design.kind === 'layout' && (!(design.elements || []).length || design.elements?.some(layer => layer.type === 'image' && !layerImages[layer.id]))) { setError('Add a layer and choose an image for every image layer.'); return; }
    setBusy(true); setError('');
    try {
      const savedDesign: Design = { ...design,elements:design.elements?.map(layer=>({...layer})) };
      const savedImages = { ...layerImages };
      for (const layer of savedDesign.elements || []) if (layer.type === 'image' && !layer.asset) {
        const source=layerImages[layer.id] as HTMLImageElement, frame=document.createElement('canvas');
        const normalized=renderDesign(frame,{...defaults,kind:'image'},source);
        layer.asset=await uploadPacket(normalized.packet);
        const iw=source.naturalWidth || source.width, ih=source.naturalHeight || source.height, scale=Math.min(WIDTH/iw,HEIGHT/ih);
        layer.source_rect=[(WIDTH-iw*scale)/2,(HEIGHT-ih*scale)/2,iw*scale,ih*scale]; savedImages[layer.id]=frame;
      }
      const rendered=renderDesign(canvas.current!,savedDesign,image,savedImages);
      if (rendered.overflow) throw new Error('Some content does not fit. Resize it or use a larger layer.');
      const asset=await uploadPacket(rendered.packet), id=preset?.id || uid();
      await api('/presets',{...savedDesign,id,asset,name:name.trim() || design.text.split('\n')[0].slice(0,40) || 'New screen'});
      let ready = false;
      for (let retry = 0; retry < 15; retry++) {
        const state = await api('/state') as State;
        if (state.presets.some(item => item.id === id && item.asset === asset)) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (!ready) throw new Error('The controller has not finished saving. Check the library before trying again.');
      await onSaved(id, send ? target : undefined);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <>
    <div className="page-heading editor-heading"><div><button className="text-button" onClick={onClose}><Icon name="back" size={16}/>Back to saved screens</button><h1>{preset ? 'Make a few changes.' : 'A blank canvas.'}</h1><p>Make something for your little corner of the world.</p></div>
      <div className="heading-actions"><button className="button secondary" disabled={busy || overflow} onClick={() => save(false)}>{busy ? 'Saving…' : 'Save screen'}</button><button className="button primary" disabled={busy || overflow || !target} onClick={() => save(true)}><Icon name="send" size={17}/>Save & send</button></div></div>
    <div className="editor-layout"><section className="editor-stage"><div className="stage-toolbar"><span className="eyebrow">LIVE PREVIEW</span><span className="small muted">640 × 384</span></div>
      {design.kind === 'layout' ? <LayoutEditor design={design} change={setDesign} canvas={canvas} images={layerImages} setImages={setLayerImages}/> : <div className="editor-paper"><canvas ref={canvas} aria-label="Live screen preview"/></div>}
      <div className="preview-caption"><span className="palette-dots"><i/><i/><i/></span>Rendered in your display's three-color palette</div>
      {overflow && <p className="form-error" role="alert">This message doesn't fit. Reduce the text size or shorten it.</p>}
      <div className="send-target"><Icon name="displays"/><label>Send to<select value={target} onChange={e => setTarget(e.target.value)}>{devices.map(device => <option key={device.serial} value={device.serial}>{device.name}</option>)}</select></label></div>
    </section><aside className="inspector"><h3>The details</h3><label>Screen name<input placeholder="A name you'll remember" maxLength={40} value={name} onChange={e => setName(e.target.value)}/></label>
      <div className="segmented"><button className={design.kind === 'text' ? 'selected' : ''} onClick={() => update('kind', 'text')}>Text</button><button className={design.kind === 'image' ? 'selected' : ''} onClick={() => update('kind', 'image')}><Icon name="image" size={16}/>Image</button><button className={design.kind === 'layout' ? 'selected' : ''} onClick={() => update('kind','layout')}>Layout</button></div>
      {design.kind === 'text' ? <><label>Message<textarea aria-label="Message" rows={5} maxLength={500} value={design.text} onChange={e => update('text', e.target.value)}/></label>
        <div className="form-grid"><label>Typeface<select value={design.font} onChange={e => update('font', e.target.value as Design['font'])}><option value="sans">Sans serif</option><option value="serif">Serif</option><option value="mono">Monospace</option></select></label>
        <label>Text size<select value={design.font_size} onChange={e => update('font_size', Number(e.target.value))}>{[20,24,28,32,40,48,56,64,72,80,96].map(size => <option key={size} value={size}>{size} px</option>)}</select></label></div>
        <label>Alignment<div className="segmented">{(['left','center','right'] as const).map(align => <button key={align} className={design.align === align ? 'selected' : ''} onClick={() => update('align', align)}>{align}</button>)}</div></label>
        <label>Layout<select value={design.template} onChange={e => update('template', e.target.value as Design['template'])}><option value="center">Centered message</option><option value="notice">Notice</option></select></label>
        <ColorPicker title="Text color" value={design.color} change={value => update('color', value)}/></> : design.kind === 'image' ? <div className="image-upload"><Icon name="image" size={30}/><p>{image ? 'Image ready to save' : 'Bring your own pixels'}</p><span className="small muted">Crop, rotate and tune your image before converting it to display colors.</span><button className="button secondary" onClick={() => upload.current?.click()}>{image ? 'Replace image' : 'Choose an image'}</button>{image && <button className="button secondary" onClick={()=>setPreparingImage(image)}>Prepare image</button>}
          <input hidden type="file" accept="image/*" ref={upload} onChange={async e => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 10000000) { setError('Choose an image smaller than 10 MB.'); return; } const url = URL.createObjectURL(file); const img = new Image(); img.onload = () => { if(img.naturalWidth*img.naturalHeight>40000000){setError('Choose an image under 40 megapixels.');}else{setPreparingImage(img);setError('');} URL.revokeObjectURL(url); }; img.onerror = () => { setError('This image could not be opened.'); URL.revokeObjectURL(url); }; img.src = url; }}/></div> : <p className="small muted">Add text, shapes, QR codes, and images with the layer controls below the preview.</p>}
      {design.kind !== 'image' && <label className="checkbox-label"><input type="checkbox" checked={design.dynamic || false} onChange={e=>update('dynamic',e.target.checked)}/>Live data template</label>}
      {design.dynamic && <p className="small muted">Use variables such as {'{{temperature}}'}, {'{{status}}'}, or {'{{time}}'} in text. Connect this screen to a source under Live data.</p>}
      <ColorPicker title="Paper color" value={design.background} change={value => update('background', value)}/>
      <p className="inspector-note"><Icon name="book" size={17}/>Saved screens are available on the controller's wheel menu, even with your browser closed.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
    </aside></div>
    {preparingImage && <ImagePreparation source={preparingImage} onCancel={()=>setPreparingImage(null)} onApply={prepared=>{setImage(prepared);setPreparingImage(null);}}/>}
  </>;
}
function ColorPicker({ title, value, change }: { title: string; value: Ink; change: (value: Ink) => void }) {
  return <fieldset className="color-picker"><legend>{title}</legend>{(['black','white','yellow'] as const).map(color => <button type="button" key={color} className={'swatch ' + color + (value === color ? ' chosen' : '')} aria-label={`${title}: ${color}`} aria-pressed={value === color} onClick={() => change(color)}>{value === color && <Icon name="check" size={17}/>}</button>)}<span>{value}</span></fieldset>;
}

function App() {
  const [state, setState] = useState<State | null>(null), [online, setOnline] = useState(false);
  const [healthSerial,setHealthSerial] = useState(''), [templatePicker,setTemplatePicker] = useState(false);
  const [page, setPage] = useState<Page>('Displays'), [editor, setEditor] = useState<Preset | 'new' | null>(null);
  const [deviceDialog, setDeviceDialog] = useState<Display | 'new' | null>(null), [sendTo, setSendTo] = useState<Display | null>(null);
  const [selectedPreset, setSelectedPreset] = useState(''), [search, setSearch] = useState('');
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null), [sending, setSending] = useState(false);
  const [remove, setRemove] = useState<Preset | null>(null), [pair, setPair] = useState<Display | null>(null);
  const alive = useRef(true), refreshBusy = useRef(false);
  const notify = useCallback((text: string, error = false) => { setToast({ text, error }); }, []);
  const refresh = useCallback(async () => {
    if (refreshBusy.current) return;
    refreshBusy.current = true;
    try { const result = await api('/state'); if (alive.current) { setState(result); setOnline(true); } }
    catch { if (alive.current) setOnline(false); }
    finally { refreshBusy.current = false; }
  }, []);
  useEffect(() => { alive.current = true; refresh(); const timer = setInterval(refresh, 1500); return () => { alive.current = false; clearInterval(timer); }; }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 6500); return () => clearTimeout(timer); }, [toast]);
  const devices = state?.devices || [], presets = state?.presets || [], jobs = state?.jobs || [];
  const pending = jobs.filter(job => job.state === 'sending' || job.state === 'queued' || job.state === 'retrying');
  function navigate(next: Page) { if (editor && !window.confirm('Leave this draft without saving?')) return; setEditor(null); setPage(next); setSearch(''); }
  async function send(serial: string, preset: string) {
    await api('/jobs', { serial, preset }); notify('Screen added to the transfer queue.'); setSendTo(null); setPage('Activity'); await refresh();
  }
  async function run(action: () => Promise<unknown>, success: string) { try { await action(); notify(success); await refresh(); } catch (e) { notify((e as Error).message, true); } }
  const recent = jobs.filter(job => job.state === 'completed').slice(0, 3);
  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="#" onClick={e => { e.preventDefault(); navigate('Displays'); }}><span className="brand-mark"><i/><i/><i/></span><span>chroma<span className="brand-sub">STUDIO</span></span></a>
      <div className="workspace-label">YOUR WORKSPACE</div><nav aria-label="Main navigation">{(['Displays','Saved screens','Automations','Diagnostics','Live data','Activity','History','Settings'] as Page[]).map((item, index) => <button key={item} className={page === item ? 'active' : ''} onClick={() => navigate(item)}><Icon name={['displays','library','clock','activity','wifi','activity','clock','settings'][index]}/><span>{item}</span>{item === 'Activity' && pending.length > 0 && <b className="nav-count">{pending.length}</b>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="controller-indicator"><span className={'status-dot' + (online ? ' connected' : '')}/><span>{online ? 'Controller connected' : 'Connecting to controller'}</span></div><span className="sidebar-ip">{state?.controller.ip || 'Waiting for a connection'}</span><div className="sidebar-device"><span className="tiny-device"/><span>LILYGO T-Embed<small>CC1101 Plus</small></span></div><span className="sidebar-version">Chroma Studio · {state?.controller.version || '0.3.0'}</span></div>
    </aside>
    <main><div className="topbar"><span><span className="muted">Workspace</span><span className="breadcrumb-slash">/</span>{editor ? 'Screen editor' : page}</span><div><span className="radio-dot"/>{pending.length ? `${pending.length} transfer${pending.length === 1 ? '' : 's'} in queue` : 'Ready when you are'}<span className="avatar">C</span></div></div>
      {!online && <div className="connection-banner" role="status"><Icon name="wifi" size={18}/>{state ? 'Connection interrupted. Reconnecting to your controller…' : 'Looking for your controller…'}<button onClick={refresh}>Retry</button></div>}
      <div className="page-content">{editor ? <Editor key={editor === 'new' ? 'new' : editor.id} preset={editor === 'new' ? undefined : editor} devices={devices} onClose={() => { setEditor(null); setPage('Saved screens'); }} onSaved={async (id, serial) => { await refresh(); if (serial) await send(serial, id); else { notify('Screen saved to your library and controller.'); setPage('Saved screens'); } setEditor(null); }}/>
      : <>
      <div className="page-heading"><div><span className="eyebrow">{page === 'Displays' ? 'A PLACE FOR EVERY PIXEL' : page === 'Saved screens' ? 'MADE TO BE KEPT' : page === 'Activity' ? 'BEHIND THE SCREENS' : 'MAKE YOURSELF AT HOME'}</span><h1>{page === 'Displays' ? 'Your displays.' : page === 'Saved screens' ? 'The little library.' : page === 'Activity' ? 'Every update, in view.' : page === 'Automations' ? 'Good timing.' : page === 'Diagnostics' ? 'A closer look.' : page === 'History' ? 'Worth seeing again.' : page === 'Live data' ? 'Keep it current.' : 'Your studio, your way.'}</h1><p>{page === 'Displays' ? 'Choose a display. Send something worth keeping.' : page === 'Saved screens' ? 'Create once. Send again, from here or the controller.' : page === 'Activity' ? 'Follow each screen from the queue to a display acknowledgement.' : 'Connection details and the tools that keep things running.'}</p></div>
        {page === 'Displays' && <button className="button primary" disabled={!online} onClick={() => setDeviceDialog('new')}><Icon name="plus" size={18}/>Add display</button>}
        {page === 'Saved screens' && <div className="heading-actions"><button className="button secondary" onClick={()=>setTemplatePicker(true)}>Use a template</button><button className="button primary" disabled={!online} onClick={() => setEditor('new')}><Icon name="plus" size={18}/>Create a screen</button></div>}
      </div>
      {page === 'Displays' && <>
        <div className="overview"><div><span className="stat-icon"><Icon name="displays"/></span><div><strong>{devices.length}</strong><span>display{devices.length === 1 ? '' : 's'} in your studio</span></div></div><div><span className="stat-icon"><Icon name="library"/></span><div><strong>{presets.length}</strong><span>saved screen{presets.length === 1 ? '' : 's'}</span></div></div><div><span className="stat-icon"><Icon name="activity"/></span><div><strong>{jobs.filter(job => job.state === 'completed').length}</strong><span>recent acknowledged transfers</span></div></div></div>
        <div className="section-heading"><h2>All displays <span>{devices.length}</span></h2><span className="small muted">Yours to make useful.</span></div>
        <div className="device-grid">{devices.map(device => {
          const last = presets.find(preset => preset.id === device.last_preset), job = pending.find(job => job.serial === device.serial);
          return <article className="device-card" key={device.serial}><div className="card-heading"><span className="small uppercase">CHROMA74</span><button className="icon-button" aria-label={`Settings for ${device.name}`} onClick={() => setDeviceDialog(device)}><Icon name="settings" size={18}/></button></div>
            <div className="device-bezel"><Preview preset={last}/><span className="bezel-logo">chroma</span></div><div className="device-info"><div><h3>{device.name}</h3><p className="serial">{device.serial}</p></div><span className="palette-dots"><i/><i/><i/></span></div>
            <div className="device-state">{job ? <Badge state={job.state}/> : <span className="small muted"><span className={'status-dot' + (device.last_ack ? ' connected' : '')}/>{device.last_ack ? 'Display acknowledged' : 'Configured · awaiting an update'}</span>}<span className="small muted">640 × 384</span></div>
            <div className="card-actions"><button className="button secondary" onClick={()=>{setHealthSerial(device.serial);navigate('Diagnostics');}}>Health</button><button className="button secondary" onClick={() => setPair(device)} disabled={!online || !!job}>Pair</button><button className="button dark" disabled={!online || !presets.length} onClick={() => { setSelectedPreset(presets[0]?.id || ''); setSendTo(device); }}>Send a screen<Icon name="arrow" size={16}/></button></div></article>;
        })}<button className="add-display-card" disabled={!online} onClick={() => setDeviceDialog('new')}><span><Icon name="plus" size={24}/></span><strong>Room for one more.</strong><p>Add another display to your studio</p></button></div>
        {!presets.length && <div className="getting-started"><span className="getting-icon"><Icon name="edit" size={26}/></span><div><h3>Your first screen starts here.</h3><p>A reminder, a welcome note, a favorite quote. Make it yours, then send it in a click.</p></div><button className="button secondary" disabled={!online} onClick={() => { setPage('Saved screens'); setEditor('new'); }}>Create a screen<Icon name="arrow" size={16}/></button></div>}
        {recent.length > 0 && <section className="recent-section"><div className="section-heading"><h2>Recently sent</h2><button className="text-button" onClick={() => navigate('Activity')}>View activity<Icon name="arrow" size={15}/></button></div>{recent.map(job => <JobRow key={job.id} job={job} devices={devices} cancel={() => {}}/>)}</section>}
      </>}
      {page === 'Saved screens' && <><div className="library-toolbar"><input type="search" aria-label="Search saved screens" placeholder="Find a saved screen…" value={search} onChange={e => setSearch(e.target.value)}/><span className="small muted">{presets.length} of 20 screens</span></div>
        {presets.length ? <div className="preset-grid">{presets.filter(preset => preset.name.toLowerCase().includes(search.toLowerCase())).map(preset => <article className="preset-card" key={preset.id}><button className="preset-preview-button" aria-label={`Edit ${preset.name}`} onClick={() => setEditor(preset)}><Preview preset={preset}/></button><div className="preset-card-body"><h3>{preset.name}</h3><p className="small muted">{preset.dynamic ? 'Live template' : preset.kind === 'layout' ? 'Layout' : preset.kind === 'image' ? 'Image' : 'Text screen'}<span className="middle-dot">·</span>640 × 384</p><div className="preset-actions"><button className="text-button" onClick={() => setEditor(preset)}><Icon name="edit" size={15}/>Edit</button><button className="text-button subtle" onClick={() => setRemove(preset)}>Delete</button><button className="button compact dark" disabled={!devices.length || !online} onClick={() => { setSendTo(devices[0]); setSelectedPreset(preset.id); }}><Icon name="send" size={15}/>Send</button></div></div></article>)}</div>
        : <div className="empty-state"><span className="empty-art"><span/><span/><span/></span><h2>A little space for your ideas.</h2><p>Your saved screens will live here, ready for a quick send<br/>from your browser or the wheel on your controller.</p><button className="button primary" disabled={!online} onClick={() => setEditor('new')}><Icon name="plus" size={17}/>Create your first screen</button></div>}
      </>}
      {page === 'Activity' && <>{jobs.some(job=>!['queued','sending','retrying'].includes(job.state)) && <div className="feature-actions"><button className="button secondary" onClick={()=>{if(confirm('Clear finished activity? Pending transfers and saved screens stay.'))run(()=>api('/jobs/clear',{}),'Finished activity cleared.');}}>Clear finished activity</button></div>}{jobs.length ? <div className="activity-list">{jobs.map(job => <JobRow key={job.id} job={job} devices={devices} cancel={() => run(() => api('/jobs/cancel', { id: job.id }), 'Transfer cancellation requested.')}/>)}</div> : <div className="empty-state"><span className="empty-icon"><Icon name="activity" size={40}/></span><h2>Quiet looks good on you.</h2><p>Your transfers and their progress will appear here.</p><button className="button secondary" onClick={() => navigate('Saved screens')}>Browse saved screens</button></div>}<p className="footnote">“Acknowledged” means the display replied to the transfer. The last 12 jobs survive controller reboots. Visual confirmation is recorded separately under Diagnostics.</p></>}
      {state && page === 'Automations' && <AutomationsPage state={state} refresh={refresh} notify={notify}/>}
      {state && page === 'Diagnostics' && <HealthPage state={state} selected={healthSerial} refresh={refresh} notify={notify}/>}
      {state && page === 'History' && <HistoryPage state={state} refresh={refresh} notify={notify}/>}
      {state && page === 'Live data' && <LiveDataPage state={state} notify={notify}/>}
      {page === 'Settings' && <div className="settings-grid">{state && <><ControllerSettings state={state} refresh={refresh} notify={notify}/><BackupControls state={state} refresh={refresh} notify={notify}/><MqttSettings state={state} notify={notify}/><FirmwareUpdates state={state} notify={notify}/></>}<section className="settings-card"><span className="settings-icon"><Icon name="wifi"/></span><h2>Your connection</h2><p className="muted">The studio lives on your LILYGO. No cloud account needed.</p><dl><dt>Controller address</dt><dd>{state?.controller.ip || '—'}</dd><dt>Connection</dt><dd>{online ? 'Connected' : 'Reconnecting'}</dd><dt>Firmware</dt><dd>{state?.controller.version || '—'}</dd><dt>Radio state</dt><dd>{state?.controller.radio_mode || '—'}</dd></dl><a className="button secondary" href="/wifi">Wi-Fi settings<Icon name="arrow" size={16}/></a></section>
        <section className="settings-card"><span className="settings-icon"><Icon name="displays"/></span><h2>In your hands</h2><p className="muted">The controller works with the same displays and saved screens as this app.</p><dl><dt>Turn the wheel</dt><dd>Browse items</dd><dt>Press the wheel</dt><dd>Select / confirm send</dd><dt>Hold the wheel</dt><dd>Go back</dd><dt>Side button</dt><dd>Return home</dd></dl><p className="small muted">Choose Displays → your display → a saved screen → press to send.</p></section>
        <section className="settings-card"><span className="settings-icon"><Icon name="book"/></span><h2>A few useful tools</h2><p className="muted">Keep a copy of your studio configuration or connect your own tools.</p><a className="button secondary" href="/api/v1/export" download>Export configuration<Icon name="copy" size={16}/></a><p className="small muted">Exports names and screen metadata. Screen images and Wi-Fi passwords are not included.</p><code>GET /api/v1/state</code><code>POST /api/v1/jobs</code><p className="small muted">The API uses the same queue as the wheel and this interface.</p></section>
        <section className="settings-card"><h2>A little breathing room</h2><p className="muted">Storage on your controller.</p><div className="storage-number">{((state?.controller.storage_used || 0) / 1048576).toFixed(2)}<span> / {((state?.controller.storage_total || 0) / 1048576).toFixed(1)} MB</span></div><div className="progress-track"><i style={{ width: `${(state?.controller.storage_used || 0) / (state?.controller.storage_total || 1) * 100}%` }}/></div><p className="small muted">{presets.length} saved screens · {devices.length} displays</p></section></div>}
      </>}
      <footer className="page-footer"><span>Less noise. More meaning.</span><span>CHROMA STUDIO<span className="footer-square"/></span></footer>
      </div>
    </main>
    {templatePicker && <Modal title="Start with a template" close={()=>setTemplatePicker(false)}><div className="template-gallery">{[
      {name:'Weather',text:'WEATHER\n{{temperature}}?\n{{condition}}',dynamic:true,font_size:48},
      {name:'Server status',text:'SERVER STATUS\n{{status}}\nCPU {{cpu}}%',dynamic:true,font_size:48},
      {name:'Calendar',text:'NEXT EVENT\n{{event}}\n{{when}}',dynamic:true,font_size:40},
      {name:'Clock & date',text:'{{time}}\n{{date}}',dynamic:true,font_size:64},
      {name:'QR notice',text:'',kind:'layout',elements:[{id:'title',type:'text',x:40,y:30,w:560,h:80,color:'black',text:'Scan for details',font_size:40},{id:'qr',type:'qr',x:220,y:130,w:200,h:200,color:'black',text:'https://example.com'}]}
    ].map(template=><button className="settings-card" key={template.name} onClick={()=>{setEditor({...defaults,...template,id:uid(),asset:'',name:template.name} as Preset);setTemplatePicker(false);}}><h3>{template.name}</h3><p className="small muted">{template.dynamic ? 'Live data template' : 'Drag-and-drop layout'}</p></button>)}</div></Modal>}
    {deviceDialog && <DeviceDialog device={deviceDialog === 'new' ? undefined : deviceDialog} nextId={Math.max(122, ...devices.map(device => device.id)) + 1} close={() => setDeviceDialog(null)} save={async device => { await api('/displays', device); notify('Display saved.'); await refresh(); }}/ >}
    {sendTo && <Modal title="Send a little something." close={() => { if (!sending) setSendTo(null); }}><p className="muted">Choose a saved screen for <strong>{sendTo.name}</strong>.</p><label>Display<select value={sendTo.serial} onChange={e => setSendTo(devices.find(device => device.serial === e.target.value)!)}>{devices.map(device => <option key={device.serial} value={device.serial}>{device.name}</option>)}</select></label><label>Saved screen<select value={selectedPreset} onChange={e => setSelectedPreset(e.target.value)}>{presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label><Preview preset={presets.find(preset => preset.id === selectedPreset)}/><p className="small muted">The display will refresh after the transfer completes. You can follow it in Activity.</p><div className="modal-actions"><button className="button secondary" disabled={sending} onClick={() => setSendTo(null)}>Cancel</button><button className="button primary" disabled={sending || !selectedPreset} onClick={async () => { setSending(true); try { await send(sendTo.serial, selectedPreset); } catch (e) { notify((e as Error).message, true); } finally { setSending(false); } }}><Icon name="send" size={17}/>{sending ? 'Adding…' : 'Send to display'}</button></div></Modal>}
    {remove && <Modal title="Delete this saved screen?" close={() => setRemove(null)}><p className="muted">“{remove.name}” will be removed from your library. The image currently on a display will stay there.</p><div className="modal-actions"><button className="button secondary" onClick={() => setRemove(null)}>Keep screen</button><button className="button danger" onClick={async () => { await run(() => api('/presets/delete', { id: remove.id }), 'Saved screen removed.'); setRemove(null); }}>Delete screen</button></div></Modal>}
    {pair && <Modal title="Pair this display?" close={() => setPair(null)}><p className="muted">The controller will contact <strong>{pair.serial}</strong> and assign it display ID {pair.id}. Keep the display nearby with working batteries.</p><div className="modal-actions"><button className="button secondary" onClick={() => setPair(null)}>Cancel</button><button className="button primary" onClick={async () => { await run(() => api('/displays/activate', { serial: pair.serial }), 'Pairing added to the queue.'); setPair(null); setPage('Activity'); }}>Pair display</button></div></Modal>}
    {toast && <div className={'toast' + (toast.error ? ' error' : '')} role={toast.error ? 'alert' : 'status'}><Icon name={toast.error ? 'close' : 'check'} size={19}/>{toast.text}<button aria-label="Dismiss notification" onClick={() => setToast(null)}><Icon name="close" size={16}/></button></div>}
  </div>;
}

function JobRow({ job, devices, cancel }: { job: Job; devices: Display[]; cancel: () => void }) {
  const live = job.state === 'sending' || job.state === 'queued' || job.state === 'retrying';
  return <article className="job-row"><span className={'job-icon ' + job.state}><Icon name={job.state === 'completed' ? 'check' : job.kind === 'activate' ? 'displays' : 'send'}/></span><div className="job-main"><strong>{job.title}</strong><span className="small muted">{devices.find(device => device.serial === job.serial)?.name || job.serial}{job.error && <span className="job-error"> · {job.error}</span>}</span>{live && <div className="progress-track"><i style={{ width: `${job.progress}%` }}/></div>}</div><div className="job-status"><Badge state={job.state}/>{job.state === 'retrying' && <span className="small muted">Retry in {Math.ceil((job.retry_in_ms || 0)/1000)}s</span>}{job.state === 'sending' && <span className="small muted">{job.kind === 'activate' ? 'Waiting for a reply' : `${job.progress}% transferred`}</span>}</div>{live && <button className="icon-button" aria-label={`Cancel ${job.title}`} onClick={cancel}><Icon name="close" size={18}/></button>}</article>;
}

createRoot(document.getElementById('root')!).render(<App/>);
