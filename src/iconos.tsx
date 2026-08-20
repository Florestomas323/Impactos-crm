// ═══════════════════════════════════════════════════════════════
//  REGISTRO CENTRAL DE ICONOS  ·  ImpactOS
//  ---------------------------------------------------------------
//  Un solo lugar para toda la iconografía de la interfaz.
//  Se usan iconos de línea (Lucide) en vez de emojis: se ven
//  consistentes en todos los sistemas operativos, heredan el color
//  del texto y se alinean con el diseño oscuro premium.
//
//  Los emojis SÍ se conservan en las plantillas de WhatsApp, en los
//  textos exportados y en las marcas semánticas del código, porque
//  eso es contenido que el cliente lee fuera de la app.
// ═══════════════════════════════════════════════════════════════
import {
  AlarmClock, AlertTriangle, ArrowRight, ArrowUp, Asterisk, Ban, Banknote, BarChart3, Bell, Bolt,
  Hourglass, Timer,
  Bookmark, Bot, Brain, Briefcase, Brush, Building2, Cake, Calculator, Calendar,
  CalendarDays, Camera, Car, Check, CheckCircle2, CheckSquare, ChevronDown,
  Clapperboard, ClipboardList, Clock, Contact, CookingPot, CreditCard, Crown,
  Database, DollarSign, DoorOpen, Download, Droplet, Dumbbell, Eye, EyeOff, File,
  FileText, Filter, Flame, FolderOpen, Folders, Gamepad2, Gift, Hand, Handshake,
  Heart, HeartHandshake, Home, IdCard, Image, Inbox, Key, Landmark, Lightbulb,
  Link, Lock, Magnet, Mail, Mailbox, Map, MapPin, Medal, Menu, MessageCircle,
  Package, Paperclip, PartyPopper, Pencil, PenLine, Phone, PhoneCall, PhoneOff,
  Pin, Plus, Printer, RadioTower, Receipt, Recycle, RefreshCw, Repeat, Rocket,
  Save, ScanSearch, ScrollText, Search, Send, Settings, Shield, ShoppingCart,
  ShowerHead, Siren, Smartphone, Sparkles, Sprout, Square, Star, Tag, Target,
  ThumbsUp, TrendingUp, Trash2, Trophy, Truck, Tv, Unlock, Upload, User, Users,
  Wind, Wrench, X, XCircle, Zap, Circle,
} from "lucide-react";

// Mapa emoji → icono. La clave es el emoji que ya existía en el código,
// así la migración es segura y no hay que reescribir cada estructura de datos.
export const ICONOS = {
  // ── Navegación y secciones ──────────────────────────────────
  "🏠": Home, "📞": Phone, "📅": Calendar, "🔧": Wrench, "📂": FolderOpen,
  "🎁": Gift, "🔍": Search, "🧲": Magnet, "💵": Banknote, "🔎": ScanSearch,
  "🧮": Calculator, "🗺": Map, "🎂": Cake, "🏆": Trophy, "📈": TrendingUp,
  "📊": BarChart3, "⚙": Settings, "🗄": Database, "🗂": Folders, "📇": Contact,

  // ── Relojes y espera ────────────────────────────────────────
  "⏰": AlarmClock, "⏳": Hourglass, "⏱": Timer, "🕐": Clock,

  // ── Estados y validación ────────────────────────────────────
  "✅": CheckCircle2, "✓": Check, "☑": CheckSquare, "❌": XCircle, "✕": X,
  "✖": X, "⚠": AlertTriangle, "⛔": Ban, "🚫": Ban, "🚷": Ban, "🚨": Siren,

  // ── Acciones ────────────────────────────────────────────────
  "🗑": Trash2, "✏": Pencil, "✍": PenLine, "➕": Plus, "💾": Save,
  "🖨": Printer, "🔄": RefreshCw, "🔁": Repeat, "📤": Upload, "📥": Inbox,
  "🧹": Brush, "♻": Recycle, "🔗": Link, "📎": Paperclip, "⬆": ArrowUp,
  "🔜": ArrowRight, "👁": Eye, "🙈": EyeOff,

  // ── Dinero y ventas ─────────────────────────────────────────
  "💰": DollarSign, "💳": CreditCard, "🧾": Receipt, "🏦": Landmark,
  "🛒": ShoppingCart, "🏷": Tag, "💼": Briefcase,

  // ── Personas ────────────────────────────────────────────────
  "👤": User, "👥": Users, "🤝": Handshake, "🙏": HeartHandshake,
  "👋": Hand, "✋": Hand, "👑": Crown, "🪪": IdCard,

  // ── Comunicación ────────────────────────────────────────────
  "💬": MessageCircle, "✉": Mail, "📨": Send, "📮": Mailbox, "📭": Inbox,
  "📱": Smartphone, "📲": Smartphone, "☎": PhoneCall, "📵": PhoneOff,
  "🔔": Bell, "📡": RadioTower,

  // ── Documentos ──────────────────────────────────────────────
  "📋": ClipboardList, "📝": FileText, "📄": File, "📜": ScrollText,
  "🔖": Bookmark, "📌": Pin, "🖼": Image, "📷": Camera,

  // ── Tiempo y lugar ──────────────────────────────────────────
  "🗓": CalendarDays, "📆": CalendarDays, "📍": MapPin,
  "🏙": Building2, "🚪": DoorOpen, "🚗": Car, "🚚": Truck,

  // ── Producto y servicio ─────────────────────────────────────
  "🍳": CookingPot, "💧": Droplet, "🚿": ShowerHead, "🔩": Bolt,
  "📦": Package, "🔑": Key, "🔒": Lock, "🔓": Unlock, "🛡": Shield,

  // ── Logros y motivación ─────────────────────────────────────
  "🎯": Target, "🔥": Flame, "🎉": PartyPopper, "🥳": PartyPopper,
  "🥇": Medal, "🥈": Medal, "🥉": Medal, "⭐": Star, "★": Star,
  "🌟": Sparkles, "✨": Sparkles, "🙌": ThumbsUp, "💪": Dumbbell,
  "🚀": Rocket, "🌱": Sprout, "😍": Heart, "🎮": Gamepad2,

  // ── Varios ──────────────────────────────────────────────────
  "🤖": Bot, "🧠": Brain, "💡": Lightbulb, "⚡": Zap, "🎬": Clapperboard,
  "📺": Tv, "💨": Wind, "✳": Asterisk,

  // ── Puntos de color (semáforos de estado) ───────────────────
  "🟢": Circle, "🔴": Circle, "🟠": Circle, "🟡": Circle, "🔵": Circle,
  "⬜": Square,
};

// Puntos de color: conservan su significado de semáforo mediante el color,
// ya que el icono por sí solo no comunica el estado.
const COLOR_PUNTO = {
  "🟢": "text-[#6EE7B7]",
  "🔴": "text-[#FCA5A5]",
  "🟠": "text-[#FDBA74]",
  "🟡": "text-[#FCD34D]",
  "🔵": "text-[#93C5FD]",
};

// Emojis que se rellenan (los puntos de semáforo se ven mejor macizos)
const RELLENOS = new Set(["🟢", "🔴", "🟠", "🟡", "🔵", "⬜", "⭐", "★"]);

/**
 * Icono de interfaz.
 *
 * @param e     Emoji original que actúa como clave semántica (ej. "📞")
 * @param size  Tamaño en px. Por defecto 16 (escala Lucide recomendada)
 * @param className  Clases extra (color, margen…)
 */
export function Ico({ e, size = 16, className = "", strokeWidth = 1.75, ...rest }) {
  // Varios emojis vienen con "variation selector" (U+FE0F), ej. "🗺️".
  // Lo quitamos para que la búsqueda en el registro siempre acierte.
  const clave = typeof e === "string" ? e.replace(/\uFE0F/g, "") : e;
  const C = ICONOS[clave];
  // Si algún emoji no está mapeado, no rompemos la interfaz: no mostramos nada
  // visible pero dejamos rastro en consola para poder añadirlo al registro.
  if (!C) {
    if (typeof console !== "undefined") console.warn("[ImpactOS] Icono sin mapear:", e);
    return null;
  }
  const color = COLOR_PUNTO[clave] || "";
  return (
    <C
      width={size}
      height={size}
      strokeWidth={strokeWidth}
      className={`inline-block shrink-0 ${color} ${className}`}
      fill={RELLENOS.has(clave) ? "currentColor" : "none"}
      // Alinea el icono con la línea base del texto cuando va en línea con él.
      style={{ verticalAlign: "-0.125em" }}
      aria-hidden="true"
      {...rest}
    />
  );
}

const RE_EMOJI_INICIAL =
  /^\s*([\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{23E9}-\u{23FA}\u{2705}\u{274C}\u{2B50}]\uFE0F?)\s*/u;

/**
 * Muestra un texto de estado (avisos, banners, mensajes de resultado) que en
 * los datos todavía empieza por un emoji. Se conservan a propósito porque el
 * código los usa como marca semántica (p. ej. fbError.startsWith("📡")).
 */
export function Msg({ children, size = 15, className = "" }) {
  if (typeof children !== "string") return children ?? null;
  const m = children.match(RE_EMOJI_INICIAL);
  if (!m) return children;
  return (
    <>
      <Ico e={m[1]} size={size} className={`mt-px ${className}`} />
      <span>{children.slice(m[0].length)}</span>
    </>
  );
}

/** Quita el emoji inicial de un texto, sin añadir icono. */
export function sinEmoji(t) {
  return typeof t === "string" ? t.replace(RE_EMOJI_INICIAL, "") : t;
}

// Iconos usados directamente en la estructura de la app (no vienen de emojis)
export { Menu, ChevronDown, Filter, Download, Search, Plus, X, Bell, Settings };
