/** Wall-clock picker only. Time-zone and future-time validation stay in delivery-time.ts. */
export interface DeliveryTimePicker {
  /** Settle an in-progress scroll before the confirmation reads the value. */
  settle(): void;
  dispose(): void;
}

const ROW_HEIGHT = 36;
let nextPickerId = 0;
const range = (first: number, last: number): number[] => Array.from({ length: last - first + 1 }, (_, index) => first + index);
const pad = (value: number): string => String(value).padStart(2, '0');

class TimeWheel {
  private list: HTMLElement;
  private items: HTMLElement[] = [];
  private selected = -1;
  private values: number[] = [];
  private disposed = false;

  constructor(host: HTMLElement, label: string, private id: string, values: number[], value: number,
    private changed: (value: number) => void) {
    const column = host.createDiv({ cls: 'xpd-time-column' });
    column.createDiv({ cls: 'xpd-time-heading', text: label });
    const frame = column.createDiv({ cls: 'xpd-time-frame' });
    this.list = frame.createDiv({ cls: 'xpd-time-wheel', attr: {
      role: 'listbox', tabindex: '0', 'aria-label': label, 'aria-orientation': 'vertical',
    } });
    this.setOptions(values, value);
    this.list.onscroll = () => this.readScroll();
    this.list.onkeydown = event => {
      const steps: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 };
      let index = this.selected;
      if (event.key in steps) index += steps[event.key];
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = this.values.length - 1;
      else return;
      event.preventDefault();
      this.choose(index);
    };
  }

  setOptions(values: number[], value: number): void {
    this.values = values;
    this.list.empty();
    this.selected = -1;
    this.items = values.map((option, index) => {
      const item = this.list.createDiv({ cls: 'xpd-time-option', text: pad(option), attr: {
        id: `${this.id}-${option}`, role: 'option', 'aria-selected': 'false',
      } });
      item.onclick = () => { this.list.focus({ preventScroll: true }); this.choose(index); };
      return item;
    });
    this.select(Math.max(0, values.indexOf(value)), false);
    this.list.scrollTop = this.selected * ROW_HEIGHT;
  }

  private select(index: number, notify: boolean): void {
    if (this.disposed) return;
    index = Math.max(0, Math.min(this.values.length - 1, index));
    if (index === this.selected) return;
    this.items[this.selected]?.setAttribute('aria-selected', 'false');
    this.selected = index;
    this.items[index].setAttribute('aria-selected', 'true');
    this.list.setAttribute('aria-activedescendant', this.items[index].id);
    if (notify) this.changed(this.values[index]);
  }

  private choose(index: number): void {
    this.select(index, true);
    // An immediate move keeps the highlighted value and submitted value identical.
    this.list.scrollTo({ top: this.selected * ROW_HEIGHT, behavior: 'instant' });
  }

  private readScroll(): void { this.select(Math.round(this.list.scrollTop / ROW_HEIGHT), true); }

  settle(): void { this.readScroll(); this.choose(this.selected); }

  dispose(): void {
    this.disposed = true;
    this.list.onscroll = this.list.onkeydown = null;
    for (const item of this.items) item.onclick = null;
  }
}

export function mountDeliveryTimePicker(host: HTMLElement, initial: string, changed: (value: string) => void): DeliveryTimePicker {
  const parts = initial.split(/[-T:]/).map(Number);
  const pickerId = `xpd-time-${++nextPickerId}`;
  const root = host.createDiv({ cls: 'xpd-time-picker' });
  root.createDiv({ cls: 'xpd-time-title', text: '日期和时间' });
  root.createDiv({ cls: 'xpd-time-hint', text: '上下滚动或点击选择，中间高亮为选定时间' });
  const wheelsHost = root.createDiv({ cls: 'xpd-time-wheels', attr: { role: 'group', 'aria-label': '发布时间' } });
  const wheels: TimeWheel[] = [];
  const daysInMonth = (): number => new Date(Date.UTC(parts[0], parts[1], 0)).getUTCDate();
  const notify = (): void => changed(`${parts[0]}-${pad(parts[1])}-${pad(parts[2])}T${pad(parts[3])}:${pad(parts[4])}`);
  // A publish scheduler only needs upcoming years; keep the scroll list small.
  const firstYear = new Date().getFullYear();
  const values = [range(firstYear, firstYear + 49), range(1, 12), range(1, daysInMonth()), range(0, 23), range(0, 59)];
  ['年', '月', '日', '时', '分'].forEach((label, index) => {
    wheels.push(new TimeWheel(wheelsHost, label, `${pickerId}-${index}`, values[index], parts[index], value => {
      parts[index] = value;
      if (index < 2) {
        // Clamp Jan 31 -> Feb 28/29 before exposing the updated value to validation.
        parts[2] = Math.min(parts[2], daysInMonth());
        wheels[2].setOptions(range(1, daysInMonth()), parts[2]);
      }
      notify();
    }));
  });
  return {
    settle() { for (const wheel of wheels) wheel.settle(); },
    dispose() { for (const wheel of wheels) wheel.dispose(); },
  };
}
