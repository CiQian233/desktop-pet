import type { PetConfig, PetPersonality } from '../config-types';

export type DialogueKind = 'startup' | 'time' | 'random';
export type DayPeriod = 'morning' | 'afternoon' | 'evening' | 'night';

export interface DialogueLine {
  text: string;
  kind: DialogueKind;
  period: DayPeriod;
}

export function periodForHour(hour: number): DayPeriod {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h >= 5 && h < 11) return 'morning';
  if (h >= 11 && h < 18) return 'afternoon';
  if (h >= 18 && h < 23) return 'evening';
  return 'night';
}

const STARTUP: Record<PetPersonality, string[]> = {
  gentle: ['{name}来陪你啦，今天也慢慢来。', '你回来啦，{name}在这里等你。'],
  lively: ['{name}闪亮登场！今天要做点什么？', '启动成功！{name}已经准备好玩耍啦。'],
  aloof: ['{name}到了。你忙你的，我随便逛逛。', '开机了？那{name}就勉为其难陪你一会儿。'],
};

const PERIOD: Record<PetPersonality, Record<DayPeriod, string[]>> = {
  gentle: {
    morning: ['早安，先伸个懒腰再开始吧。', '清晨适合喝杯温水，{name}陪你。'],
    afternoon: ['午后有点长，记得起来走几步。', '忙完这一小段，就让自己歇一会儿。'],
    evening: ['傍晚啦，今天已经努力很久了。', '要不要收个尾？{name}陪你慢慢收尾。'],
    night: ['夜深了，别忘记早点休息。', '{name}会安静待着，你也别太晚睡。'],
  },
  lively: {
    morning: ['早上好！{name}的精神已经满格啦！', '新的一天，先和{name}击个掌吧！'],
    afternoon: ['下午也要活力满满！要不要走动一下？', '{name}巡逻时间到！顺便看看你。'],
    evening: ['晚上好！今天有什么开心的事吗？', '一天快结束啦，和{name}分享一下吧！'],
    night: ['夜色来啦，{name}准备安静充电。', '再忙也要睡觉哦，明天接着玩！'],
  },
  aloof: {
    morning: ['早。咖啡自己倒，{name}只负责陪。', '天亮了。别太累，听见没有。'],
    afternoon: ['下午了。坐这么久，起来一下也好。', '{name}只是路过，不是特意来看你。'],
    evening: ['晚上了。今天的事做不完就明天再说。', '收工吧，{name}也觉得差不多了。'],
    night: ['很晚了。{name}先睡，你随意。', '别熬太久，明天还会见面。'],
  },
};

const RANDOM: Record<PetPersonality, string[]> = {
  gentle: ['{name}刚刚数了数，今天也很喜欢你。', '累了的话，可以摸摸我的头。', '我在这里，不着急。'],
  lively: ['{name}发现你啦！要一起玩吗？', '尾巴摇摇，心情好好！', '要不要给{name}换个散步速度？'],
  aloof: ['看什么？{name}只是刚好在这里。', '可以摸一下，就一下。', '你忙吧，我替你看着桌面。'],
};

export function chooseDialogue(
  config: Pick<PetConfig, 'petName' | 'personality'>,
  kind: DialogueKind,
  date = new Date(),
  random = Math.random,
): DialogueLine {
  const period = periodForHour(date.getHours());
  const pool = kind === 'startup' ? STARTUP[config.personality]
    : kind === 'time' ? PERIOD[config.personality][period]
      : RANDOM[config.personality];
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return {
    text: pool[Math.max(0, index)].replaceAll('{name}', config.petName),
    kind,
    period,
  };
}
