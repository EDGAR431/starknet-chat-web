/**
 * Navegación espacial por mando de Xbox (D-pad / stick izquierdo).
 *
 * No hace nada hasta que el navegador detecta un gamepad real conectado
 * (evento "gamepadconnected") — así no afecta en absoluto a quien use la
 * app con ratón/teclado o táctil. Pensado para correr dentro del
 * envoltorio UWP de Xbox, pero funciona igual en cualquier navegador de
 * escritorio con un mando conectado, útil para probarlo sin la consola.
 */

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [role="button"]';

const DEADZONE = 0.5;
const REPEAT_DELAY_MS = 220; // evita que el foco "vuele" varias casillas de golpe

let navActive = false;
let rafId: number | null = null;
let lastMoveAt = 0;
let prevPressed: Record<string, boolean> = {};

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

function getFocusables(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    isVisible,
  );
}

function centerOf(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

type Direction = "up" | "down" | "left" | "right";

function findNearest(
  current: HTMLElement,
  candidates: HTMLElement[],
  direction: Direction,
): HTMLElement | null {
  const cur = centerOf(current);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const el of candidates) {
    if (el === current) continue;
    const c = centerOf(el);
    const dx = c.x - cur.x;
    const dy = c.y - cur.y;

    let primary: number;
    let secondary: number;
    let valid: boolean;

    switch (direction) {
      case "down":
        valid = dy > 4;
        primary = dy;
        secondary = Math.abs(dx);
        break;
      case "up":
        valid = dy < -4;
        primary = -dy;
        secondary = Math.abs(dx);
        break;
      case "right":
        valid = dx > 4;
        primary = dx;
        secondary = Math.abs(dy);
        break;
      case "left":
        valid = dx < -4;
        primary = -dx;
        secondary = Math.abs(dy);
        break;
    }

    if (!valid) continue;
    // Penaliza fuertemente el desvío lateral, para preferir el elemento
    // "más recto" en esa dirección antes que uno diagonal más cercano.
    const score = primary + secondary * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best;
}

function moveFocus(direction: Direction) {
  const now = performance.now();
  if (now - lastMoveAt < REPEAT_DELAY_MS) return;

  const focusables = getFocusables();
  if (focusables.length === 0) return;

  const active = document.activeElement as HTMLElement | null;
  const current =
    active && focusables.includes(active) ? active : focusables[0];

  const next = findNearest(current, focusables, direction);
  if (next) {
    next.focus();
    next.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    lastMoveAt = now;
  }
}

function activateFocused() {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return;
  // Si es un campo de texto, con que tenga el foco basta — el propio
  // sistema (Xbox / WebView2) se encarga de sacar el teclado en pantalla.
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return;
  el.click();
}

function goBack() {
  const active = document.activeElement as HTMLElement | null;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
    active.blur();
    return;
  }
  // Intenta cerrar un modal/hoja abierta antes de navegar hacia atrás
  const closer = document.querySelector<HTMLElement>(
    '[aria-label="Close"], [data-testid="modal-close"], [role="dialog"] button',
  );
  if (closer) {
    closer.click();
    return;
  }
  history.back();
}

function pollGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = pads[0];

  if (pad) {
    const b = pad.buttons;
    const axisX = pad.axes[0] ?? 0;
    const axisY = pad.axes[1] ?? 0;

    const up = !!b[12]?.pressed || axisY < -DEADZONE;
    const down = !!b[13]?.pressed || axisY > DEADZONE;
    const left = !!b[14]?.pressed || axisX < -DEADZONE;
    const right = !!b[15]?.pressed || axisX > DEADZONE;
    const aBtn = !!b[0]?.pressed;
    const bBtn = !!b[1]?.pressed;

    if (up) moveFocus("up");
    if (down) moveFocus("down");
    if (left) moveFocus("left");
    if (right) moveFocus("right");
    if (aBtn && !prevPressed.a) activateFocused();
    if (bBtn && !prevPressed.b) goBack();

    prevPressed = { a: aBtn, b: bBtn };
  }

  rafId = requestAnimationFrame(pollGamepad);
}

export function initGamepadNavigation() {
  window.addEventListener("gamepadconnected", () => {
    if (navActive) return;
    navActive = true;
    document.body.classList.add("gamepad-nav-active");

    const focusables = getFocusables();
    if (focusables[0]) focusables[0].focus();

    pollGamepad();
  });

  window.addEventListener("gamepaddisconnected", () => {
    const remaining = navigator.getGamepads
      ? Array.from(navigator.getGamepads()).filter(Boolean)
      : [];
    if (remaining.length > 0) return; // sigue habiendo otro mando conectado

    navActive = false;
    document.body.classList.remove("gamepad-nav-active");
    if (rafId !== null) cancelAnimationFrame(rafId);
  });
}
