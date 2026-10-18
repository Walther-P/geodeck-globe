export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

let toastTimer = 0;

export function toast(text: string, ms = 3800): void {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add("hidden"), ms);
}

/** Bottom sheet: one at a time; `onClose` lets the owner stop streams/timers. */
export class Sheet {
  private onClose: (() => void) | null = null;
  kind = "";

  constructor() {
    $("sheetClose").addEventListener("click", () => this.close());
    this.swipeToClose();
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.kind) this.close();
    });
  }

  open(kind: string, eyebrow: string, title: string, html: string, onClose?: () => void): HTMLElement {
    this.close();
    this.kind = kind;
    this.onClose = onClose ?? null;
    $("sheetEyebrow").textContent = eyebrow;
    $("sheetTitle").textContent = title;
    const body = $("sheetBody");
    body.innerHTML = html;
    body.scrollTop = 0;
    $("sheet").classList.remove("hidden");
    document.body.dataset.sheet = kind;
    return body;
  }

  setTitle(title: string): void {
    $("sheetTitle").textContent = title;
  }

  close(): void {
    if (!this.kind) return;
    const done = this.onClose;
    this.onClose = null;
    this.kind = "";
    $("sheet").classList.add("hidden");
    $("sheetBody").innerHTML = "";
    delete document.body.dataset.sheet;
    done?.();
  }

  private swipeToClose(): void {
    const head = $("sheet").querySelector<HTMLElement>(".sheet-head")!;
    const grip = $("sheet").querySelector<HTMLElement>(".sheet-grip")!;
    let startY: number | null = null;
    const start = (e: TouchEvent) => (startY = e.touches[0].clientY);
    const end = (e: TouchEvent) => {
      if (startY !== null && e.changedTouches[0].clientY - startY > 60) this.close();
      startY = null;
    };
    for (const el of [head, grip]) {
      el.addEventListener("touchstart", start, { passive: true });
      el.addEventListener("touchend", end, { passive: true });
    }
  }
}
