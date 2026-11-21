import { contextBridge, ipcRenderer } from 'electron';

export interface BubblePayload {
  name: string;
  text: string;
  kind: string;
  period: string;
}

export interface BubblePlacement {
  placement: 'above' | 'below';
  tailX: number;
}

contextBridge.exposeInMainWorld('bubble', {
  onShow: (cb: (payload: BubblePayload) => void) => {
    ipcRenderer.on('bubble:show', (_e, payload) => cb(payload));
  },
  onPlacement: (cb: (placement: BubblePlacement) => void) => {
    ipcRenderer.on('bubble:placement', (_e, placement) => cb(placement));
  },
});
