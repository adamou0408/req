/**
 * jsdom 沒有 matchMedia，也不會真的排版。
 * 這裡提供一個只看畫面寬度的替身，讓測試可以切換手機／桌面。
 */
type Listener = (event: MediaQueryListEvent) => void;

interface FakeList {
  query: string;
  matches: boolean;
  listeners: Set<Listener>;
}

let width = 1280;
const lists = new Set<FakeList>();

function evaluate(query: string): boolean {
  const max = /max-width:\s*([\d.]+)px/.exec(query);
  const min = /min-width:\s*([\d.]+)px/.exec(query);
  if (max?.[1] !== undefined && width > Number(max[1])) return false;
  if (min?.[1] !== undefined && width < Number(min[1])) return false;
  return max !== null || min !== null;
}

function createList(query: string): MediaQueryList {
  const list: FakeList = { query, matches: evaluate(query), listeners: new Set() };
  lists.add(list);
  return {
    media: query,
    get matches() {
      return list.matches;
    },
    onchange: null,
    addEventListener: (_type: string, listener: Listener) => list.listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => list.listeners.delete(listener),
    addListener: (listener: Listener) => list.listeners.add(listener),
    removeListener: (listener: Listener) => list.listeners.delete(listener),
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
}

export function installMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: createList,
  });
}

/** 改變畫面寬度，並通知所有結果有變的 media query。 */
export function setViewportWidth(next: number): void {
  width = next;
  for (const list of lists) {
    const matches = evaluate(list.query);
    if (matches === list.matches) continue;
    list.matches = matches;
    const event = { matches, media: list.query } as MediaQueryListEvent;
    list.listeners.forEach((listener) => listener(event));
  }
}
