export type Ink = 'black' | 'white' | 'yellow';
export interface Display { serial: string; name: string; id: number; palette: string; channel: number; network: number; wake_channel: number; last_ack?: number; last_preset?: string }
export interface Design { text: string; color: Ink; background: Ink; font_size: number; align: 'left' | 'center' | 'right'; font: 'sans' | 'serif' | 'mono'; template: 'center' | 'notice'; kind: 'text' | 'image' }
export interface Preset extends Design { id: string; name: string; asset: string }
export interface Job { id: string; serial: string; preset: string; title: string; state: 'queued' | 'sending' | 'completed' | 'failed' | 'cancelled'; kind: string; error: string; progress: number; total: number; remaining: number; started: number; finished: number }
export interface State { revision: number; controller: { name: string; version: string; ip: string; connected: boolean; uptime_ms: number; heap_free: number; storage_used: number; storage_total: number; radio_mode: string; channel: number; network_id: number }; devices: Display[]; presets: Preset[]; jobs: Job[] }
