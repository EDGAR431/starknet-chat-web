import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";

import { Trans } from "@lingui/solid/macro";

import type { Dir, OskEvent } from "./engine";
import { backspace, insertText, moveCaret, pressEnter } from "./osk";

type Action = "shift" | "backspace" | "space" | "enter" | "symbols" | "letters";
interface Key {
  label: string;
  action?: Action;
  /** Ancho relativo (una tecla normal = 1) */
  w: number;
}

const k = (label: string, w = 1): Key => ({ label, w });
const act = (label: string, action: Action, w: number): Key => ({
  label,
  action,
  w,
});
const chars = (s: string): Key[] => Array.from(s).map((c) => k(c));

const LETTERS: Key[][] = [
  chars("1234567890"),
  chars("qwertyuiop"),
  chars("asdfghjklñ"),
  [act("⇧", "shift", 1.5), ...chars("zxcvbnm"), act("⌫", "backspace", 1.5)],
  [
    act("123", "symbols", 1.5),
    k(","),
    act("espacio", "space", 4),
    k("."),
    k("?"),
    act("↵", "enter", 1.5),
  ],
];

const SYMBOLS: Key[][] = [
  chars("1234567890"),
  chars("!?\"'#$%&*+"),
  chars("()[]{}<>=~"),
  [act("abc", "letters", 1.5), ...chars("áéíóúü"), act("⌫", "backspace", 1.5)],
  [
    act("abc", "letters", 1.5),
    k("¿"),
    act("espacio", "space", 4),
    k("¡"),
    k(":"),
    act("↵", "enter", 1.5),
  ],
];

/** Centro horizontal de cada tecla de una fila, en unidades de tecla */
function centers(row: Key[]): number[] {
  let x = 0;
  return row.map((key) => {
    const c = x + key.w / 2;
    x += key.w;
    return c;
  });
}

/**
 * Teclado en pantalla para escribir con el mando. Recibe la entrada del motor
 * mientras está abierto, escribe en el campo que tiene el foco y no se lo quita.
 *
 *  A escribir · X borrar · Y espacio · LB/RB mover cursor · LT mayúsculas
 *  RT símbolos · Menú intro/enviar · B cerrar
 */
export function OnScreenKeyboard(props: {
  open: boolean;
  register: (handler: ((e: OskEvent) => void) | null) => void;
  onClose: () => void;
}) {
  const [symbols, setSymbols] = createSignal(false);
  const [shift, setShift] = createSignal(false);
  const [pos, setPos] = createSignal({ row: 1, col: 0 });
  let root: HTMLDivElement | undefined;

  const rows = () => (symbols() ? SYMBOLS : LETTERS);

  function clampPos(row: number, col: number) {
    const r = Math.max(0, Math.min(rows().length - 1, row));
    const c = Math.max(0, Math.min(rows()[r].length - 1, col));
    return { row: r, col: c };
  }

  function move(dir: Dir) {
    const { row, col } = pos();
    if (dir === "left") setPos(clampPos(row, col - 1));
    else if (dir === "right") setPos(clampPos(row, col + 1));
    else {
      const nextRow = Math.max(
        0,
        Math.min(rows().length - 1, row + (dir === "down" ? 1 : -1)),
      );
      if (nextRow === row) return;
      const from = centers(rows()[row])[col];
      const targets = centers(rows()[nextRow]);
      let best = 0;
      targets.forEach((c, i) => {
        if (Math.abs(c - from) < Math.abs(targets[best] - from)) best = i;
      });
      setPos({ row: nextRow, col: best });
    }
  }

  function press(key: Key) {
    switch (key.action) {
      case "shift":
        setShift((s) => !s);
        return;
      case "backspace":
        backspace();
        return;
      case "space":
        insertText(" ");
        return;
      case "enter":
        pressEnter();
        return;
      case "symbols":
        setSymbols(true);
        setPos(clampPos(3, 0));
        return;
      case "letters":
        setSymbols(false);
        setPos(clampPos(3, 0));
        return;
    }
    insertText(shift() && !symbols() ? key.label.toUpperCase() : key.label);
    if (shift()) setShift(false); // mayúscula de un solo uso
  }

  function handle(e: OskEvent) {
    if (e.kind === "dir") return move(e.dir);
    switch (e.name) {
      case "A": {
        const key = rows()[pos().row][pos().col];
        if (key) press(key);
        break;
      }
      case "B":
        props.onClose();
        break;
      case "X":
        backspace();
        break;
      case "Y":
        insertText(" ");
        break;
      case "LB":
        moveCaret(-1);
        break;
      case "RB":
        moveCaret(1);
        break;
      case "LT":
        setShift((s) => !s);
        break;
      case "RT":
        setSymbols((s) => !s);
        setPos(clampPos(pos().row, pos().col));
        break;
      case "MENU":
        pressEnter();
        break;
    }
  }

  createEffect(() => {
    if (!props.open) return;
    props.register(handle);
    const root_ = document.documentElement;
    root_.classList.add("osk-open");
    const frame = requestAnimationFrame(() => {
      root_.style.setProperty("--osk-h", `${root?.offsetHeight ?? 0}px`);
      // El campo queda visible por encima del teclado
      (document.activeElement as HTMLElement | null)?.scrollIntoView?.({
        block: "nearest",
      });
    });
    onCleanup(() => {
      cancelAnimationFrame(frame);
      props.register(null);
      root_.classList.remove("osk-open");
      root_.style.removeProperty("--osk-h");
      setShift(false);
      setSymbols(false);
      setPos({ row: 1, col: 0 });
    });
  });

  return (
    <Show when={props.open}>
      <div
        ref={root}
        class="gp-osk"
        data-gp-ignore=""
        onMouseDown={(e) => e.preventDefault()}
      >
        <div class="gp-osk-rows">
          <For each={rows()}>
            {(row, r) => (
              <div class="gp-osk-row">
                <For each={row}>
                  {(key, c) => (
                    <button
                      type="button"
                      tabindex="-1"
                      class="gp-osk-key"
                      classList={{
                        active: pos().row === r() && pos().col === c(),
                        toggled: key.action === "shift" && shift(),
                        wide: key.w > 1,
                      }}
                      style={{ "--w": key.w }}
                      onClick={() => {
                        setPos({ row: r(), col: c() });
                        press(key);
                      }}
                    >
                      {shift() && !symbols() && !key.action
                        ? key.label.toUpperCase()
                        : key.label}
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
        <div class="gp-osk-hints" aria-hidden="true">
          <span>
            <b data-k="A">A</b> <Trans>Type</Trans>
          </span>
          <span>
            <b data-k="X">X</b> <Trans>Delete</Trans>
          </span>
          <span>
            <b data-k="Y">Y</b> <Trans>Space</Trans>
          </span>
          <span>
            <b>LB/RB</b> <Trans>Cursor</Trans>
          </span>
          <span>
            <b>LT</b> <Trans>Shift</Trans>
          </span>
          <span>
            <b>RT</b> <Trans>Symbols</Trans>
          </span>
          <span>
            <b>≡</b> <Trans>Send</Trans>
          </span>
          <span>
            <b data-k="B">B</b> <Trans>Close</Trans>
          </span>
        </div>
      </div>
    </Show>
  );
}
