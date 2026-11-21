export {};

interface BubblePayload { name: string; text: string; kind: string; period: string }
interface BubblePlacement { placement: 'above' | 'below'; tailX: number }
interface BubbleBridge {
  onShow(cb: (payload: BubblePayload) => void): void;
  onPlacement(cb: (placement: BubblePlacement) => void): void;
}
declare global { interface Window { bubble: BubbleBridge } }

const PERIOD_LABEL: Record<string, string> = {
  morning: '清晨', afternoon: '午后', evening: '傍晚', night: '夜晚',
};
const KIND_LABEL: Record<string, string> = { startup: '迎接', time: '时段', random: '闲聊' };

window.bubble.onShow((payload) => {
  document.getElementById('bubble-name')!.textContent = payload.name;
  document.getElementById('bubble-period')!.textContent = payload.kind === 'time'
    ? PERIOD_LABEL[payload.period] ?? KIND_LABEL.time
    : KIND_LABEL[payload.kind] ?? PERIOD_LABEL[payload.period] ?? '';
  document.getElementById('bubble-text')!.textContent = payload.text;
  const card = document.getElementById('bubble-card')!;
  card.classList.remove('show');
  void card.offsetWidth;
  card.classList.add('show');
});

window.bubble.onPlacement(({ placement, tailX }) => {
  const card = document.getElementById('bubble-card')!;
  card.classList.toggle('below', placement === 'below');
  const safeX = Math.max(24, Math.min(316, Number.isFinite(tailX) ? tailX : 170));
  card.style.setProperty('--tail-x', `${safeX - 10}px`);
});
