/**
 * Motor de mando (Gamepad API) de StarknetChat.
 *
 * Convierte un mando estándar (Xbox / PlayStation / genéricos con mapping
 * "standard") en navegación completa de la interfaz:
 *
 *  - D-pad / stick izquierdo: mover el foco espacialmente
 *  - A: activar · B: atrás/cerrar · X: menú contextual · Y: escribir
 *  - LB / RB: cambiar de zona (servidores, canales, chat, escribir, miembros)
 *  - Stick derecho: desplazar · LT / RT: página arriba / abajo
 *  - Vista: silenciar micrófono · Menú: ajustes · L3: ensordecer
 *
 * No hace absolutamente nada hasta que el navegador detecta un mando, y deja
 * de tener efecto visible en cuanto el usuario vuelve al ratón o al teclado.
 * Funciona igual en un navegador de escritorio (para probar) que dentro del
 * envoltorio de Xbox (WebView2).
 */

export type Zone =
  | "servers"
  | "channels"
  | "header"
  | "messages"
  | "composer"
  | "members"
  | "voice"
  | "content"
  | "layer";

export type PadAction = "toggleMute" | "toggleDeafen" | "openSettings";

export interface GamepadUiState {
  /** Hay un mando conectado */
  connected: boolean;
  /** Último método de entrada usado */
  input: "gamepad" | "pointer";
  /** Hay un diálogo o menú abierto que atrapa el foco */
  layer: boolean;
  /** Se está escribiendo en un campo de texto */
  editing: boolean;
  /** Se está ajustando un deslizador con el mando */
  adjusting: boolean;
  /** Zona actual del foco */
  zone: Zone;
}

export interface EngineHooks {
  onAction: (action: PadAction) => void;
  onState: (state: GamepadUiState) => void;
  /** Se acaba de empezar a escribir en un campo usando el mando */
  onEditStart?: () => void;
  /** Hay una llamada de voz activa (VIEW silencia; si no, salta a la tarjeta de voz) */
  inCall?: () => boolean;
}

export type Dir = "up" | "down" | "left" | "right";

export type OskButton =
  | "A"
  | "B"
  | "X"
  | "Y"
  | "LB"
  | "RB"
  | "LT"
  | "RT"
  | "MENU"
  | "VIEW"
  | "L3";

/** Entrada que el motor reenvía al teclado en pantalla mientras está abierto */
export type OskEvent =
  | { kind: "dir"; dir: Dir }
  | { kind: "btn"; name: OskButton };

interface Cand {
  el: HTMLElement;
  rect: DOMRect;
  zone: Zone;
  isItem: boolean;
}

/** Botones del mapping "standard" */
const B = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  VIEW: 8,
  MENU: 9,
  L3: 10,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const;

const REPEAT_FIRST_MS = 380;
const REPEAT_NEXT_MS = 115;
const STICK_NAV = 0.6;
const STICK_ACTIVITY = 0.3;
const STICK_SCROLL_DEADZONE = 0.18;
const SCROLL_SPEED_PX_MS = 1.5;
const CACHE_MS = 350;

const ZONE_ORDER: Zone[] = [
  "servers",
  "channels",
  "voice",
  "header",
  "content",
  "messages",
  "composer",
  "members",
];

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "textarea",
  "select",
  "summary",
  '[contenteditable="true"]',
  '[contenteditable=""]',
  "[tabindex]",
  "[data-gp-item]",
  "[role=button]",
  "[role=link]",
  "[role=menuitem]",
  "[role=menuitemcheckbox]",
  "[role=menuitemradio]",
  "[role=tab]",
  "[role=option]",
  "[role=checkbox]",
  "[role=switch]",
  "[role=radio]",
  "[role=slider]",
  // Componentes web de mdui (Shadow DOM): se tratan como controles
  "mdui-text-field",
  "mdui-checkbox",
  "mdui-switch",
  "mdui-radio",
  "mdui-select",
  "mdui-slider",
  "mdui-menu-item",
  "mdui-list-item",
  "mdui-segmented-button",
  "mdui-navigation-rail-item",
  "mdui-fab",
  "mdui-button",
  "mdui-button-icon",
  "mdui-chip",
  "mdui-tab",
].join(",");

/** Roles ARIA que sí son controles (list/listitem/group... son contenedores) */
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "checkbox",
  "switch",
  "radio",
  "slider",
  "textbox",
  "combobox",
  "searchbox",
  "spinbutton",
]);

const NATIVE_TAGS = new Set([
  "MDUI-TEXT-FIELD",
  "MDUI-CHECKBOX",
  "MDUI-SWITCH",
  "MDUI-RADIO",
  "MDUI-SELECT",
  "MDUI-SLIDER",
  "MDUI-MENU-ITEM",
  "MDUI-LIST-ITEM",
  "MDUI-SEGMENTED-BUTTON",
  "MDUI-NAVIGATION-RAIL-ITEM",
  "MDUI-FAB",
  "MDUI-BUTTON",
  "MDUI-BUTTON-ICON",
  "MDUI-CHIP",
  "MDUI-TAB",
  "A",
  "BUTTON",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "SUMMARY",
]);

/** Elementos con manejador de clic registrado por Solid (delegación) */
function hasDelegatedHandler(el: Element): boolean {
  const h = el as unknown as Record<string, unknown>;
  return !!(h["$$click"] || (el as HTMLElement).onclick);
}

/**
 * Manejadores de puntero (pulsar/soltar): suelen ser de arrastrar y soltar o
 * de efectos al pasar el ratón, así que solo cuentan si además parece botón.
 */
function hasPointerHandler(el: Element): boolean {
  const h = el as unknown as Record<string, unknown>;
  return !!(h["$$pointerdown"] || h["$$mousedown"] || h["$$pointerup"]);
}

/** Elemento con foco real, atravesando Shadow DOM */
export function activeDeep(): HTMLElement | null {
  let a = document.activeElement as HTMLElement | null;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) {
    a = a.shadowRoot.activeElement as HTMLElement;
  }
  return a;
}

/** Deslizador (mdui-slider, input range o role=slider) que contiene a `el` */
function sliderOf(el: Element | null): HTMLElement | null {
  if (!el) return null;
  return el.closest?.(
    "mdui-slider, input[type=range], [role=slider]",
  ) as HTMLElement | null;
}

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === "MDUI-TEXT-FIELD") return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return ![
      "checkbox",
      "radio",
      "button",
      "submit",
      "reset",
      "range",
      "color",
      "file",
      "image",
    ].includes(el.type);
  }
  return (el as HTMLElement).isContentEditable === true;
}

function isSingleLineInput(el: Element | null): boolean {
  if (el instanceof HTMLInputElement) return isEditable(el);
  if (el?.tagName === "MDUI-TEXT-FIELD") {
    return !el.shadowRoot?.querySelector("textarea");
  }
  return false;
}

function area(r: DOMRect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

function overlap(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

export class GamepadEngine {
  private hooks: EngineHooks;
  private running = false;
  private raf = 0;
  private lastT = 0;
  private prev: boolean[] = [];
  private held: { dir: Dir | null; nextAt: number } = {
    dir: null,
    nextAt: 0,
  };
  private lastPad: Gamepad | null = null;
  private lastActivityPing = 0;
  private osk: ((e: OskEvent) => void) | null = null;
  private oskHold: { i: number; n: OskButton; nextAt: number } | null = null;

  /** Mientras hay un teclado en pantalla, recibe toda la entrada del mando */
  setOsk(handler: ((e: OskEvent) => void) | null) {
    this.osk = handler;
    this.held.dir = null;
    this.oskHold = null;
  }

  /** Sale del campo de texto sin perder el sitio en la interfaz */
  endEditing() {
    if (!this.state.editing) return;
    const host = document.activeElement as HTMLElement;
    const inner = activeDeep();
    this.soft = host;
    host.dataset.gpCurrent = "";
    inner?.blur();
    host.blur();
    this.refreshState();
  }
  private lastAction = "-";
  private cache: { at: number; list: Cand[] } | null = null;
  private dirty = true;
  private soft: HTMLElement | null = null;
  private lastByZone = new Map<string, HTMLElement>();
  private mo?: MutationObserver;
  private state: GamepadUiState = {
    connected: false,
    input: "pointer",
    layer: false,
    editing: false,
    adjusting: false,
    zone: "content",
  };

  constructor(hooks: EngineHooks) {
    this.hooks = hooks;
  }

  // ------------------------------------------------------------------ ciclo

  start() {
    if (this.running) return;
    this.running = true;

    window.addEventListener("gamepadconnected", this.onConnect);
    window.addEventListener("gamepaddisconnected", this.onDisconnect);
    window.addEventListener("resize", this.markDirty);
    document.addEventListener("scroll", this.markDirty, true);
    document.addEventListener("mousemove", this.onPointerActivity, true);
    document.addEventListener("pointerdown", this.onPointerActivity, true);
    document.addEventListener("keydown", this.onKeyActivity, true);
    document.addEventListener("focusin", this.onFocusIn, true);
    document.addEventListener("focusout", this.onFocusOut, true);

    this.mo = new MutationObserver(this.markDirty);
    this.mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "disabled", "aria-hidden"],
    });

    if (this.pickPad()) this.onConnect();
    this.raf = requestAnimationFrame(this.loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("gamepadconnected", this.onConnect);
    window.removeEventListener("gamepaddisconnected", this.onDisconnect);
    window.removeEventListener("resize", this.markDirty);
    document.removeEventListener("scroll", this.markDirty, true);
    document.removeEventListener("mousemove", this.onPointerActivity, true);
    document.removeEventListener("pointerdown", this.onPointerActivity, true);
    document.removeEventListener("keydown", this.onKeyActivity, true);
    document.removeEventListener("focusin", this.onFocusIn, true);
    document.removeEventListener("focusout", this.onFocusOut, true);
    this.mo?.disconnect();
    this.setInput("pointer");
  }

  /** Lista simplificada de destinos actuales (solo para depuración/pruebas) */
  listCandidates() {
    this.dirty = true;
    return this.candidates().map((c) => ({
      zone: c.zone,
      tag: c.el.tagName.toLowerCase(),
      item: c.isItem,
      text: (c.el.getAttribute("aria-label") || c.el.textContent || "")
        .trim()
        .slice(0, 28),
      x: Math.round(c.rect.left),
      y: Math.round(c.rect.top),
    }));
  }

  /** Datos para el panel de depuración */
  debug() {
    const cur = this.currentEl();
    return {
      pad: this.lastPad?.id ?? "(ninguno)",
      mapping: this.lastPad?.mapping ?? "",
      pressed: (this.lastPad?.buttons ?? [])
        .map((b, i) => (b.pressed ? i : -1))
        .filter((i) => i >= 0),
      axes: (this.lastPad?.axes ?? []).slice(0, 4).map((a) => +a.toFixed(2)),
      candidates: this.cache?.list.length ?? 0,
      zone: this.state.zone,
      layer: this.state.layer,
      editing: this.state.editing,
      adjusting: this.state.adjusting,
      last: this.lastAction,
      current: cur
        ? `${cur.tagName.toLowerCase()}${cur.id ? "#" + cur.id : ""} "${(
            cur.getAttribute("aria-label") ||
            cur.textContent ||
            ""
          )
            .trim()
            .slice(0, 30)}"`
        : "(ninguno)",
    };
  }

  // ------------------------------------------------------------- eventos

  private onConnect = () => {
    this.setState({ connected: true });
  };

  private onDisconnect = () => {
    if (!this.pickPad()) {
      this.lastPad = null;
      this.setState({ connected: false });
      this.setInput("pointer");
    }
  };

  private stateStale = false;
  private lastRefresh = 0;

  private markDirty = () => {
    this.dirty = true;
    this.stateStale = true;
  };

  private onPointerActivity = (e: Event) => {
    if (!e.isTrusted) return;
    if (e instanceof MouseEvent && e.type === "mousemove") {
      if (Math.abs(e.movementX) + Math.abs(e.movementY) === 0) return;
    }
    this.setInput("pointer");
  };

  private onKeyActivity = (e: Event) => {
    // Teclear en un campo (teclado físico o en pantalla) no significa que se
    // haya dejado el mando: se mantiene el anillo y la ayuda visibles.
    if (e.isTrusted && !this.state.editing) this.setInput("pointer");
  };

  private selfFocus = false;

  private onFocusIn = (e: Event) => {
    const t = e.target as HTMLElement | null;
    if (t && !this.selfFocus) {
      // El foco lo movió otra cosa (ratón, teclado): pasa a ser el actual
      this.soft = t;
    }
    document.querySelectorAll("[data-gp-current]").forEach((n) => {
      if (n !== this.soft && n !== t) n.removeAttribute("data-gp-current");
    });
    this.refreshState();
  };
  private onFocusOut = () => setTimeout(() => this.refreshState(), 0);

  private setInput(input: "gamepad" | "pointer") {
    if (this.state.input === input) return;
    document.documentElement.dataset.input = input;
    this.setState({ input });
  }

  private setState(patch: Partial<GamepadUiState>) {
    const next = { ...this.state, ...patch };
    const changed = (Object.keys(next) as (keyof GamepadUiState)[]).some(
      (k) => next[k] !== this.state[k],
    );
    if (!changed) return;
    this.state = next;
    this.hooks.onState(next);
  }

  private beforeLayer: HTMLElement | null = null;
  private adjusting: HTMLElement | null = null;
  private adjRun = 0;
  private adjLast = 0;

  /** Sale del modo ajuste de deslizador */
  private endAdjust() {
    this.adjusting?.removeAttribute("data-gp-adjusting");
    this.adjusting = null;
    this.setState({ adjusting: false });
  }

  /** Mueve el deslizador `steps` pasos (negativo = hacia la izquierda) */
  private adjustSlider(steps: number) {
    const s = this.adjusting;
    if (!s || !s.isConnected) {
      this.endAdjust();
      return;
    }
    const num = (v: unknown, d: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : d;
    };
    const min = num(
      (s as unknown as { min?: number }).min ?? s.getAttribute("min"),
      0,
    );
    const max = num(
      (s as unknown as { max?: number }).max ?? s.getAttribute("max"),
      100,
    );
    let step = num(
      (s as unknown as { step?: number }).step ?? s.getAttribute("step"),
      1,
    );
    if (!(step > 0)) step = (max - min) / 20 || 1;
    const cur = num(
      (s as unknown as { value?: number }).value ?? s.getAttribute("value"),
      min,
    );
    let next = cur + steps * step;
    next = Math.min(max, Math.max(min, next));
    // redondeo a la rejilla de pasos (evita 0.30000000000000004)
    next = min + Math.round((next - min) / step) * step;
    next = Math.min(max, Math.max(min, +next.toFixed(6)));
    if (next === cur) {
      this.rumble(0.3, 25); // tope del recorrido
      return;
    }
    (s as unknown as { value: number }).value = next;
    if (s instanceof HTMLInputElement) s.value = String(next);
    for (const type of ["input", "change"]) {
      s.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    }
    this.lastAction = `slider ${cur} → ${next}`;
    this.rumble(0.08, 12);
  }

  private refreshState() {
    const cur = this.currentEl();
    const layer = !!this.layerRoot();
    if (layer && !this.state.layer) this.beforeLayer = cur;
    const closed = !layer && this.state.layer;
    this.setState({
      editing: isEditable(activeDeep()) || isEditable(document.activeElement),
      layer,
      zone: cur ? this.zoneOf(cur) : this.state.zone,
    });
    if (closed && this.state.input === "gamepad") {
      setTimeout(() => this.restoreAfterLayer(), 30);
    } else if (
      this.state.input === "gamepad" &&
      this.soft &&
      !this.soft.isConnected
    ) {
      // El elemento actual desapareció (se navegó o se volvió a dibujar)
      this.soft = null;
      setTimeout(() => this.restoreNearest(), 60);
    }
  }

  private restoreNearest() {
    if (this.currentEl()) return;
    this.dirty = true;
    const cands = this.candidates();
    if (!cands.length) return;
    this.setCurrent(this.nearest(cands) ?? this.defaultTarget(cands));
  }

  /** Al cerrarse un diálogo o menú, el foco vuelve a donde estaba */
  private restoreAfterLayer() {
    this.dirty = true;
    const cands = this.candidates();
    const prev = this.beforeLayer;
    let target: Cand | undefined;
    if (prev && prev.isConnected) target = cands.find((c) => c.el === prev);
    if (!target) {
      if (this.current(cands)) return;
      if (!cands.length) return;
      target = this.defaultTarget(cands);
    }
    this.setCurrent(target);
  }

  // ---------------------------------------------------------------- bucle

  private pickPad(): Gamepad | null {
    if (!navigator.getGamepads) return null;
    for (const p of navigator.getGamepads()) if (p && p.connected) return p;
    return null;
  }

  private loop = (t: number) => {
    if (!this.running) return;
    try {
      const dt = Math.min(64, t - (this.lastT || t));
      this.lastT = t;
      if (this.stateStale && t - this.lastRefresh > 150) {
        this.stateStale = false;
        this.lastRefresh = t;
        this.refreshState();
      }
      const pad = this.pickPad();
      if (pad) {
        this.lastPad = pad;
        if (!this.state.connected) this.setState({ connected: true });
        this.handlePad(pad, t, dt);
      }
    } catch (err) {
      // Un fallo puntual nunca debe detener el mando
      console.error("[mando]", err);
    } finally {
      if (this.running) this.raf = requestAnimationFrame(this.loop);
    }
  };

  private handlePad(pad: Gamepad, t: number, dt: number) {
    const down = (i: number) => !!pad.buttons[i]?.pressed;
    const edge = (i: number) => down(i) && !this.prev[i];

    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    const rx = pad.axes[2] ?? 0;
    const ry = pad.axes[3] ?? 0;

    const activity =
      pad.buttons.some((b) => b.pressed) ||
      Math.hypot(ax, ay) > STICK_ACTIVITY ||
      Math.hypot(rx, ry) > STICK_ACTIVITY;
    if (activity) {
      this.setInput("gamepad");
      // Avisa al actualizador silencioso de que hay alguien usando la app
      if (t - this.lastActivityPing > 1000) {
        this.lastActivityPing = t;
        document.dispatchEvent(new Event("starknet:activity"));
      }
    }
    const active = this.state.input === "gamepad";

    // -- Dirección (D-pad o stick izquierdo) con repetición al mantener
    let dir: Dir | null = null;
    if (down(B.UP)) dir = "up";
    else if (down(B.DOWN)) dir = "down";
    else if (down(B.LEFT)) dir = "left";
    else if (down(B.RIGHT)) dir = "right";
    else if (Math.hypot(ax, ay) > STICK_NAV) {
      dir =
        Math.abs(ax) > Math.abs(ay)
          ? ax > 0
            ? "right"
            : "left"
          : ay > 0
            ? "down"
            : "up";
    }

    if (this.osk && active) {
      this.handleOsk(pad, t, dir);
      this.prev = pad.buttons.map((b) => b.pressed);
      return;
    }

    if (dir && active) {
      if (dir !== this.held.dir) {
        this.held = { dir, nextAt: t + REPEAT_FIRST_MS };
        this.move(dir);
      } else if (t >= this.held.nextAt) {
        this.held.nextAt = t + REPEAT_NEXT_MS;
        this.move(dir);
      }
    } else if (!dir) {
      this.held.dir = null;
    }

    // -- Botones
    if (active && this.adjusting) {
      // Mientras se ajusta un deslizador solo A/B confirman; el resto se ignora
      if (edge(B.A) || edge(B.B)) this.endAdjust();
    } else if (active) {
      if (edge(B.A)) this.activate();
      if (edge(B.B)) this.back();
      if (edge(B.X)) this.contextMenu();
      if (edge(B.Y)) this.focusComposer();
      if (edge(B.LB)) this.cycleZone(-1);
      if (edge(B.RB)) this.cycleZone(1);
      if (edge(B.LT)) this.pageScroll(-1);
      if (edge(B.RT)) this.pageScroll(1);
      if (edge(B.VIEW)) {
        if (this.hooks.inCall?.() || !this.jumpToVoice()) {
          this.hooks.onAction("toggleMute");
        }
      }
      if (edge(B.MENU)) this.hooks.onAction("openSettings");
      if (edge(B.L3)) this.hooks.onAction("toggleDeafen");

      // Stick derecho: desplazamiento continuo
      if (Math.abs(ry) > STICK_SCROLL_DEADZONE) {
        this.scrollBy(ry * dt * SCROLL_SPEED_PX_MS);
      }
    }

    this.prev = pad.buttons.map((b) => b.pressed);
  }

  private handleOsk(pad: Gamepad, t: number, dir: Dir | null) {
    const osk = this.osk;
    if (!osk) return;
    const down = (i: number) => !!pad.buttons[i]?.pressed;
    const edge = (i: number) => down(i) && !this.prev[i];

    if (dir) {
      if (dir !== this.held.dir) {
        this.held = { dir, nextAt: t + REPEAT_FIRST_MS };
        osk({ kind: "dir", dir });
      } else if (t >= this.held.nextAt) {
        this.held.nextAt = t + REPEAT_NEXT_MS;
        osk({ kind: "dir", dir });
      }
    } else {
      this.held.dir = null;
    }

    const buttons: [number, OskButton][] = [
      [B.A, "A"],
      [B.B, "B"],
      [B.X, "X"],
      [B.Y, "Y"],
      [B.LB, "LB"],
      [B.RB, "RB"],
      [B.LT, "LT"],
      [B.RT, "RT"],
      [B.MENU, "MENU"],
      [B.VIEW, "VIEW"],
      [B.L3, "L3"],
    ];
    for (const [i, name] of buttons) {
      if (edge(i)) {
        osk({ kind: "btn", name });
        // Borrar y mover el cursor se repiten al mantener pulsado
        if (name === "X" || name === "LB" || name === "RB") {
          this.oskHold = { i, n: name, nextAt: t + 420 };
        }
      }
    }
    if (this.oskHold) {
      if (!down(this.oskHold.i)) {
        this.oskHold = null;
      } else if (t >= this.oskHold.nextAt) {
        this.oskHold.nextAt = t + 70;
        osk({ kind: "btn", name: this.oskHold.n });
      }
    }
  }

  // ------------------------------------------------------------ candidatos

  private layerRoot(): HTMLElement | null {
    const floating = document.getElementById("floating");
    if (!floating) return null;
    const layers = Array.from(floating.children).reverse() as HTMLElement[];
    for (const layer of layers) {
      if (layer.closest('[role="status"],[role="alert"]')) continue;
      if (layer.matches('[role="status"],[role="alert"]')) continue;
      if (this.isModalLayer(layer, floating)) return layer;
    }
    return null;
  }

  /**
   * ¿Esta capa flotante es un diálogo o menú (atrapa el foco) o un elemento
   * permanente de la interfaz, como la tarjeta de "Unirse al canal de voz"?
   * Un control cuenta como modal si NO está dentro de un contenedor fijo
   * (menús y popovers flotan sin fijarse) o si ese contenedor fijo cubre casi
   * toda la pantalla (diálogos, ajustes). Una tarjeta fija pequeña es permanente.
   */
  private isModalLayer(layer: HTMLElement, floating: HTMLElement): boolean {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const controls: HTMLElement[] = [];
    layer
      .querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)
      .forEach((el) => controls.push(el));
    for (const el of layer.getElementsByTagName("*")) {
      if (hasDelegatedHandler(el)) controls.push(el as HTMLElement);
    }
    for (const el of controls) {
      if (!this.isShown(el)) continue;
      let fixed: HTMLElement | null = null;
      for (
        let p: HTMLElement | null = el;
        p && p !== floating;
        p = p.parentElement
      ) {
        if (getComputedStyle(p).position === "fixed") {
          fixed = p;
          break;
        }
      }
      if (!fixed) return true;
      const r = fixed.getBoundingClientRect();
      if (r.width * r.height >= 0.7 * vw * vh) return true;
    }
    return false;
  }

  private isShown(el: HTMLElement): boolean {
    const r = el.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4;
  }

  /** Etiqueta las zonas estructurales de la interfaz principal */
  private tagZones() {
    const mainBar = document.querySelector(".main_bar");
    if (mainBar) {
      const kids = Array.from(mainBar.children);
      kids[0]?.setAttribute("data-gp-zone", "servers");
      if (kids[1]) kids[1].setAttribute("data-gp-zone", "channels");
    }
    const main = document.querySelector<HTMLElement>(".app_body main");
    if (main) {
      const editor = main.querySelector(
        '.ProseMirror, textarea, [contenteditable="true"]',
      );
      let composer: Element | null = editor;
      while (composer && composer.parentElement !== main) {
        composer = composer.parentElement;
      }
      for (const child of Array.from(main.children)) {
        child.setAttribute(
          "data-gp-zone",
          child === composer ? "composer" : "messages",
        );
      }
      const sib = main.nextElementSibling;
      if (sib) sib.setAttribute("data-gp-zone", "members");
      const body = main.parentElement;
      if (body) {
        const header = body.previousElementSibling;
        if (header && !header.hasAttribute("data-gp-zone")) {
          header.setAttribute("data-gp-zone", "header");
        }
      }
    }
  }

  private zoneOf(el: Element): Zone {
    if (this.layerRoot()?.contains(el)) return "layer";
    // Tarjeta de voz flotante ("Unirse al canal de voz", controles de llamada)
    if (document.getElementById("floating")?.contains(el)) return "voice";
    const z = el.closest<HTMLElement>("[data-gp-zone]")?.dataset.gpZone;
    return (z as Zone) || "content";
  }

  private candidates(): Cand[] {
    const now = performance.now();
    if (this.cache && !this.dirty && now - this.cache.at < CACHE_MS) {
      return this.cache.list;
    }
    this.tagZones();

    const layer = this.layerRoot();
    // Sin diálogo abierto: la interfaz y los elementos flotantes permanentes
    const roots: HTMLElement[] = layer
      ? [layer]
      : ([
          document.getElementById("root") ?? document.body,
          document.getElementById("floating"),
        ].filter(Boolean) as HTMLElement[]);
    const found = new Set<HTMLElement>();

    // Nivel 1: semánticos
    for (const root of roots) {
      root
        .querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)
        .forEach((el) => found.add(el));
    }

    // Nivel 2: manejadores de clic delegados por Solid
    const all: HTMLElement[] = [];
    for (const root of roots) {
      all.push(
        ...(Array.from(root.getElementsByTagName("*")) as HTMLElement[]),
      );
    }
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!found.has(el) && hasDelegatedHandler(el)) found.add(el);
    }

    // Nivel 3: apariencia de "botón" (cursor: pointer) en el borde donde empieza
    const pointerCache = new Map<Element, boolean>();
    const isPointer = (el: Element): boolean => {
      let v = pointerCache.get(el);
      if (v === undefined) {
        v = getComputedStyle(el).cursor === "pointer";
        pointerCache.set(el, v);
      }
      return v;
    };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (let i = 0; i < all.length; i++) {
      const el = all[i] as HTMLElement;
      if (found.has(el)) continue;
      const tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "path") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue;
      if (!isPointer(el)) continue;
      const parent = el.parentElement;
      if (parent && isPointer(parent) && !hasPointerHandler(el)) continue;
      found.add(el);
    }

    // Filtrado: visibilidad real, no deshabilitados, no ocultos
    const list: Cand[] = [];
    for (const el of found) {
      if (el.closest('[inert],[aria-hidden="true"],[data-gp-ignore]')) continue;
      if (
        el.matches(":disabled") ||
        el.hasAttribute("disabled") ||
        el.getAttribute("aria-disabled") === "true"
      )
        continue;
      if (
        el.getAttribute("tabindex") === "-1" &&
        !el.dataset.gp &&
        !NATIVE_TAGS.has(el.tagName) &&
        !hasDelegatedHandler(el) &&
        !el.hasAttribute("data-gp-item")
      )
        continue;
      const label = (
        el.getAttribute("aria-label") ||
        el.textContent ||
        ""
      ).trim();
      if (/^drag[-_ ]?handle$/i.test(label)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh)
        continue;
      // Prueba de impacto sobre la parte visible: ¿se ve y no está tapado?
      const vl = Math.max(0, r.left);
      const vt = Math.max(0, r.top);
      const vr = Math.min(vw, r.right);
      const vb = Math.min(vh, r.bottom);
      if (vr - vl < 4 || vb - vt < 4) continue;
      const hit = document.elementFromPoint((vl + vr) / 2, (vt + vb) / 2);
      if (!hit || !el.contains(hit)) continue;
      list.push({
        el,
        rect: r,
        zone: layer ? "layer" : this.zoneOf(el),
        isItem: el.hasAttribute("data-gp-item"),
      });
    }

    // Deduplicado: un contenedor que solo envuelve a un control (o cubre casi
    // lo mismo que él) no cuenta como destino aparte: queda el control interior.
    const out = list.filter((a) => {
      if (a.isItem) return true;
      const inner = list.filter((b) => b !== a && a.el.contains(b.el));
      if (inner.length === 0) return true;
      if (inner.some((b) => area(b.rect) >= 0.85 * area(a.rect))) return false;
      if (inner.length === 1 && area(inner[0].rect) >= 0.4 * area(a.rect))
        return false;
      // Un contenedor sin semántica propia que agrupa varios controles (fila
      // de lista, categoría, menú...) no es un destino: lo son sus controles.
      if (
        inner.length >= 2 &&
        !NATIVE_TAGS.has(a.el.tagName) &&
        !INTERACTIVE_ROLES.has(a.el.getAttribute("role") || "")
      )
        return false;
      return true;
    });

    // Candidatos casi idénticos en pantalla (p. ej. un enlace y su envoltorio
    // hermano): se queda el más "nativo" o el más interior.
    const iou = (a: DOMRect, b: DOMRect) => {
      const w = overlap(a.left, a.right, b.left, b.right);
      const h = overlap(a.top, a.bottom, b.top, b.bottom);
      const inter = w * h;
      return inter / (area(a) + area(b) - inter || 1);
    };
    const final: Cand[] = [];
    for (const c of out) {
      const twin = final.findIndex(
        (f) => !f.isItem && !c.isItem && iou(f.rect, c.rect) > 0.8,
      );
      if (twin === -1) {
        final.push(c);
      } else {
        const f = final[twin];
        const better =
          (NATIVE_TAGS.has(c.el.tagName) && !NATIVE_TAGS.has(f.el.tagName)) ||
          f.el.contains(c.el);
        if (better) final[twin] = c;
      }
    }
    out.length = 0;
    out.push(...final);

    this.cache = { at: now, list: out };
    this.dirty = false;
    return out;
  }

  // ----------------------------------------------------------- foco actual

  private currentEl(): HTMLElement | null {
    if (this.soft && this.soft.isConnected) return this.soft;
    const a = document.activeElement as HTMLElement | null;
    return a && a !== document.body ? a : null;
  }

  private current(cands: Cand[]): Cand | null {
    const el = this.currentEl();
    if (!el) return null;
    const direct = cands.find((c) => c.el === el);
    if (direct) return direct;
    // Foco dentro de un candidato (p. ej. un span dentro de un botón)
    let best: Cand | null = null;
    for (const c of cands) {
      if (c.el.contains(el) && (!best || best.el.contains(c.el))) best = c;
    }
    return best;
  }

  private lastRect: DOMRect | null = null;
  private lastZone: Zone | null = null;

  /** El destino más cercano a donde estaba el foco (tras re-render o navegar) */
  private nearest(cands: Cand[]): Cand | null {
    const lr = this.lastRect;
    if (!lr) return null;
    const cx = lr.left + lr.width / 2;
    const cy = lr.top + lr.height / 2;
    const same = cands.filter((c) => c.zone === this.lastZone);
    const pool = same.length ? same : cands;
    let best: Cand | null = null;
    let bestD = Infinity;
    for (const c of pool) {
      const d = Math.hypot(
        c.rect.left + c.rect.width / 2 - cx,
        c.rect.top + c.rect.height / 2 - cy,
      );
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  private setCurrent(c: Cand) {
    this.lastRect = c.rect;
    this.lastZone = c.zone;
    const el = c.el;
    if (this.soft && this.soft !== el) delete this.soft.dataset.gpCurrent;
    this.soft = null;

    if (isEditable(el)) {
      // No se entra a escribir hasta pulsar A (evita abrir el teclado)
      const act = activeDeep();
      if (act && act !== document.body) act.blur();
      (document.activeElement as HTMLElement | null)?.blur?.();
      el.dataset.gpCurrent = "";
      this.soft = el;
    } else {
      this.selfFocus = true;
      try {
        el.focus({ preventScroll: true });
        const ok =
          document.activeElement === el || el.contains(document.activeElement);
        if (!ok && !el.hasAttribute("tabindex")) {
          // p. ej. un <a> sin href o un <div>: se le da foco programático
          el.setAttribute("tabindex", "-1");
          el.dataset.gp = "1";
          el.focus({ preventScroll: true });
        }
      } finally {
        this.selfFocus = false;
      }
      this.soft = el;
      el.dataset.gpCurrent = "";
    }
    document
      .querySelectorAll("[data-gp-current]")
      .forEach((n) => n !== el && n.removeAttribute("data-gp-current"));

    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    this.dirty = true;
    this.lastByZone.set(c.zone, el);
    this.refreshState();
  }

  // -------------------------------------------------------------- moverse

  private move(dir: Dir) {
    if (this.adjusting) {
      // Manteniendo la dirección, el ajuste se acelera
      const now = performance.now();
      this.adjRun = now - this.adjLast < 260 ? this.adjRun + 1 : 0;
      this.adjLast = now;
      const mult = 1 + Math.floor(this.adjRun / 5) * 2;
      if (dir === "left") this.adjustSlider(-mult);
      else if (dir === "right") this.adjustSlider(mult);
      return; // arriba/abajo no hacen nada mientras se ajusta
    }
    const state = this.state;
    const active = activeDeep() ?? document.activeElement;
    // Escribiendo: solo los campos de una línea permiten salir con arriba/abajo
    if (state.editing) {
      if (!(isSingleLineInput(active) && (dir === "up" || dir === "down")))
        return;
    }

    const cands = this.candidates();
    if (cands.length === 0) return;

    const cur = this.current(cands);
    if (!cur) {
      this.setCurrent(this.nearest(cands) ?? this.defaultTarget(cands));
      return;
    }

    const next = this.pick(cur, cands, dir);
    if (next) {
      this.setCurrent(next);
      this.rumble(0.12, 18);
    } else {
      this.edgeScroll(cur, dir);
      this.rumble(0.35, 30);
    }
  }

  private pick(cur: Cand, cands: Cand[], dir: Dir): Cand | null {
    // Mensajes: navegación jerárquica (mensaje → sus botones internos)
    if (cur.zone === "messages") {
      const items = cands.filter((c) => c.isItem);
      if (cur.isItem && (dir === "up" || dir === "down")) {
        const sorted = items.sort((a, b) => a.rect.top - b.rect.top);
        const i = sorted.indexOf(cur);
        const n = dir === "down" ? sorted[i + 1] : sorted[i - 1];
        if (n) return n;
      }
      if (cur.isItem && dir === "right") {
        const inner = cands.find(
          (c) => !c.isItem && cur.el.contains(c.el) && c.el !== cur.el,
        );
        if (inner) return inner;
      }
      if (!cur.isItem && dir === "left") {
        const parent = cands.find(
          (c) => c.isItem && c.el.contains(cur.el) && c.el !== cur.el,
        );
        if (parent) return parent;
      }
    }

    const r = cur.rect;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    let best: Cand | null = null;
    let bestScore = Infinity;
    let bestSameZone: Cand | null = null;
    let bestSameScore = Infinity;

    for (const c of cands) {
      if (c === cur || c.el === cur.el) continue;
      // No saltar de un mensaje a los botones de otro mensaje ni viceversa
      const q = c.rect;
      const qx = q.left + q.width / 2;
      const qy = q.top + q.height / 2;

      let valid: boolean;
      let gap: number;
      let lateral: number;
      switch (dir) {
        case "down":
          valid = qy > cy + 3 && q.bottom > r.bottom - 2;
          gap = Math.max(0, q.top - r.bottom);
          lateral =
            overlap(r.left, r.right, q.left, q.right) > 0
              ? 0
              : Math.abs(qx - cx);
          break;
        case "up":
          valid = qy < cy - 3 && q.top < r.top + 2;
          gap = Math.max(0, r.top - q.bottom);
          lateral =
            overlap(r.left, r.right, q.left, q.right) > 0
              ? 0
              : Math.abs(qx - cx);
          break;
        case "right":
          valid = qx > cx + 3 && q.right > r.right - 2;
          gap = Math.max(0, q.left - r.right);
          lateral =
            overlap(r.top, r.bottom, q.top, q.bottom) > 0
              ? 0
              : Math.abs(qy - cy);
          break;
        default:
          valid = qx < cx - 3 && q.left < r.left + 2;
          gap = Math.max(0, r.left - q.right);
          lateral =
            overlap(r.top, r.bottom, q.top, q.bottom) > 0
              ? 0
              : Math.abs(qy - cy);
      }
      if (!valid) continue;

      const dist = Math.hypot(qx - cx, qy - cy);
      const score = gap + lateral * 3 + dist * 0.05;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
      if (c.zone === cur.zone && score < bestSameScore) {
        bestSameScore = score;
        bestSameZone = c;
      }
    }

    // Arriba/abajo: preferir quedarse en la misma zona (listas)
    if ((dir === "up" || dir === "down") && bestSameZone) return bestSameZone;
    return best;
  }

  private edgeScroll(cur: Cand, dir: Dir) {
    if (dir !== "up" && dir !== "down") return;
    const sc = this.scrollerFor(cur.el);
    if (!sc) return;
    const before = sc.scrollTop;
    sc.scrollBy({ top: dir === "down" ? 260 : -260 });
    if (sc.scrollTop === before) return;
    this.dirty = true;
    requestAnimationFrame(() => {
      const cands = this.candidates();
      const c = this.current(cands);
      if (!c) return;
      const n = this.pick(c, cands, dir);
      if (n) this.setCurrent(n);
    });
  }

  private defaultTarget(cands: Cand[]): Cand {
    const byPos = [...cands].sort(
      (a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left,
    );
    if (this.state.layer) return byPos[0];
    const remembered = [...this.lastByZone.values()].find((el) =>
      cands.some((c) => c.el === el),
    );
    if (remembered) return cands.find((c) => c.el === remembered) ?? byPos[0];
    const msgs = byPos.filter((c) => c.zone === "messages" && c.isItem);
    if (msgs.length) return msgs[msgs.length - 1];
    const chans = byPos.filter((c) => c.zone === "channels");
    if (chans.length) return chans[0];
    return byPos[0];
  }

  // ---------------------------------------------------------------- zonas

  private cycleZone(delta: 1 | -1) {
    if (this.state.layer) return;
    const cands = this.candidates();
    if (!cands.length) return;
    const zones = ZONE_ORDER.filter((z) => cands.some((c) => c.zone === z));
    if (!zones.length) return;

    const cur = this.current(cands);
    const idx = cur ? zones.indexOf(cur.zone) : -1;
    const nextZone =
      zones[(idx + delta + zones.length * 2) % zones.length] ?? zones[0];

    const inZone = cands.filter((c) => c.zone === nextZone);
    const mem = this.lastByZone.get(nextZone);
    let target = inZone.find((c) => c.el === mem);
    if (!target) {
      const sorted = [...inZone].sort(
        (a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left,
      );
      const items = sorted.filter((c) => c.isItem);
      target =
        nextZone === "messages" && items.length
          ? items[items.length - 1]
          : sorted[0];
    }
    if (target) this.setCurrent(target);
  }

  /** Salta directamente a la tarjeta de voz flotante, si existe */
  private jumpToVoice(): boolean {
    if (this.state.layer) return false;
    const cands = this.candidates().filter((c) => c.zone === "voice");
    if (!cands.length) return false;
    const mem = this.lastByZone.get("voice");
    const target =
      cands.find((c) => c.el === mem) ??
      [...cands].sort(
        (a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left,
      )[0];
    this.setCurrent(target);
    return true;
  }

  // -------------------------------------------------------------- acciones

  private activate() {
    if (this.adjusting) {
      this.endAdjust(); // A confirma el valor
      return;
    }
    let el = this.currentEl();
    if (!el) {
      const cands = this.candidates();
      if (cands.length)
        this.setCurrent(this.nearest(cands) ?? this.defaultTarget(cands));
      return;
    }
    // Deslizador: A entra en modo ajuste (izquierda/derecha cambian el valor,
    // A o B confirman), en lugar de intentar "arrastrar" con un clic
    const slider = sliderOf(el);
    if (slider) {
      this.adjusting = slider;
      slider.setAttribute("data-gp-adjusting", "");
      this.adjRun = 0;
      this.setState({ adjusting: true });
      this.rumble(0.2, 25);
      return;
    }
    if (isEditable(el)) {
      el.focus();
      this.refreshState();
      this.hooks.onEditStart?.();
      return;
    }
    if (el.dataset.gpItem !== undefined || el.hasAttribute("data-gp-item")) {
      // Un mensaje: A abre sus acciones (responder, reaccionar, editar…)
      this.contextMenu();
      return;
    }
    if (NATIVE_TAGS.has(el.tagName)) {
      this.lastAction = `click nativo ${el.tagName.toLowerCase()}`;
      el.click();
    } else {
      this.tap(el);
    }
    this.dirty = true;
    setTimeout(() => this.refreshState(), 60);
    el = null;
  }

  /** Pulsación completa, como un toque real, para manejadores de puntero */
  private tap(el: HTMLElement) {
    const r = el.getBoundingClientRect();
    const px = r.left + r.width / 2;
    const py = r.top + r.height / 2;
    // Como un clic real: el evento nace en el elemento más profundo bajo el
    // punto y sube por el árbol (así lo recogen manejadores de hijos o de
    // padres); si no se puede resolver, se usa el propio elemento.
    const hit = document.elementFromPoint(px, py) as HTMLElement | null;
    const target = hit && el.contains(hit) ? hit : el;
    this.lastAction = `tap ${el.tagName.toLowerCase()} (impacto: ${target.tagName.toLowerCase()})`;
    const init: MouseEventInit & PointerEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      button: 0,
      pointerType: "mouse",
      isPrimary: true,
    };
    target.dispatchEvent(new PointerEvent("pointerdown", init));
    target.dispatchEvent(new MouseEvent("mousedown", init));
    target.dispatchEvent(new PointerEvent("pointerup", init));
    target.dispatchEvent(new MouseEvent("mouseup", init));
    target.dispatchEvent(new MouseEvent("click", init));
  }

  private contextMenu() {
    const el = this.currentEl();
    if (!el || this.state.editing) return;
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, 120);
    const y = r.top + r.height / 2;
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
    };
    // El gestor de menús flotantes coloca el menú donde vio el último puntero
    document.dispatchEvent(new PointerEvent("pointermove", init));
    el.dispatchEvent(new MouseEvent("contextmenu", { ...init, button: 2 }));
    this.dirty = true;
    setTimeout(() => this.refreshState(), 80);
  }

  private back() {
    if (this.adjusting) {
      this.endAdjust();
      return;
    }
    if (this.state.editing) {
      this.endEditing();
      return;
    }
    if (this.layerRoot()) {
      this.closeLayer();
      return;
    }
    const cands = this.candidates();
    const cur = this.current(cands);
    const zone = cur?.zone;
    if (
      zone === "messages" ||
      zone === "composer" ||
      zone === "members" ||
      zone === "header"
    ) {
      const target =
        this.pickZone(cands, "channels") ?? this.pickZone(cands, "servers");
      if (target) {
        this.setCurrent(target);
        return;
      }
    }
    if (window.history.length > 1 && location.pathname.startsWith("/login")) {
      window.history.back();
    }
  }

  private pickZone(cands: Cand[], zone: Zone): Cand | null {
    const mem = this.lastByZone.get(zone);
    const inZone = cands.filter((c) => c.zone === zone);
    return (
      inZone.find((c) => c.el === mem) ??
      [...inZone].sort((a, b) => a.rect.top - b.rect.top)[0] ??
      null
    );
  }

  private closeLayer() {
    const target = (document.activeElement as HTMLElement) || document.body;
    // El gestor de atajos de la app registra "tecla abajo" y espera "tecla
    // arriba"; hay que enviar el par completo o la tecla queda atascada.
    const esc = (type: "keydown" | "keyup") =>
      new KeyboardEvent(type, {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        bubbles: true,
        cancelable: true,
      });
    target.dispatchEvent(esc("keydown"));
    setTimeout(() => target.dispatchEvent(esc("keyup")), 40);
    setTimeout(() => {
      const layer = this.layerRoot();
      if (layer) {
        // Plan B: botón de cerrar evidente
        const close = layer.querySelector<HTMLElement>(
          '[aria-label*="close" i], [aria-label*="cerrar" i], [aria-label*="dismiss" i]',
        );
        close?.click();
      }
      this.dirty = true;
      setTimeout(() => {
        const cands = this.candidates();
        if (!this.current(cands) && cands.length) {
          this.setCurrent(this.defaultTarget(cands));
        }
        this.refreshState();
      }, 120);
    }, 160);
  }

  private focusComposer() {
    if (this.state.layer || this.state.editing) return;
    const editor = document.querySelector<HTMLElement>(
      '[data-gp-zone="composer"] .ProseMirror, [data-gp-zone="composer"] textarea, [data-gp-zone="composer"] [contenteditable="true"], main .ProseMirror',
    );
    if (!editor) return;
    document
      .querySelectorAll("[data-gp-current]")
      .forEach((n) => n.removeAttribute("data-gp-current"));
    this.soft = null;
    editor.focus();
    this.refreshState();
    this.hooks.onEditStart?.();
  }

  // ----------------------------------------------------------- desplazar

  private scrollerFor(from: Element | null): HTMLElement | null {
    let el: Element | null = from;
    while (el && el !== document.body) {
      if (el instanceof HTMLElement) {
        const oy = getComputedStyle(el).overflowY;
        if (
          (oy === "auto" || oy === "scroll") &&
          el.scrollHeight > el.clientHeight + 2
        ) {
          return el;
        }
      }
      el = el.parentElement;
    }
    return null;
  }

  private scrollTarget(): HTMLElement | null {
    const cur = this.currentEl();
    const own = this.scrollerFor(cur);
    if (own) return own;
    // Sin foco útil: el mayor desplazable de la zona de mensajes
    let best: HTMLElement | null = null;
    document
      .querySelectorAll<HTMLElement>('[data-gp-zone="messages"]')
      .forEach((zone) => {
        [zone, ...Array.from(zone.querySelectorAll<HTMLElement>("*"))].forEach(
          (el) => {
            const oy = getComputedStyle(el).overflowY;
            if (
              (oy === "auto" || oy === "scroll") &&
              el.scrollHeight > el.clientHeight + 2 &&
              (!best || el.scrollHeight > best.scrollHeight)
            ) {
              best = el;
            }
          },
        );
      });
    return best;
  }

  private scrollBy(px: number) {
    const sc = this.scrollTarget();
    if (sc) {
      sc.scrollTop += px;
      this.dirty = true;
    }
  }

  private pageScroll(dir: 1 | -1) {
    const sc = this.scrollTarget();
    if (sc) {
      sc.scrollBy({ top: dir * sc.clientHeight * 0.8, behavior: "smooth" });
      this.dirty = true;
    }
  }

  // --------------------------------------------------------------- vibrar

  private rumble(magnitude: number, ms: number) {
    const act = (
      this.lastPad as unknown as {
        vibrationActuator?: {
          playEffect?: (t: string, p: object) => Promise<unknown>;
        };
      } | null
    )?.vibrationActuator;
    act
      ?.playEffect?.("dual-rumble", {
        duration: ms,
        strongMagnitude: 0,
        weakMagnitude: magnitude,
      })
      ?.catch?.(() => {});
  }
}
