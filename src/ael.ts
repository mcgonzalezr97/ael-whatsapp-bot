import { UserProfile, Planilla, Period } from './types';

// ─── Constantes PILA Colombia 2025 ────────────────────────────────────────
// Actualizar SMLMV cada enero con el Decreto del Gobierno Nacional
export const SMLMV = 1_750_905;              // Decretos 1469/1470 de 2025 — vigente 2026 (transitorio Decreto 0159)
export const MAX_IBC = SMLMV * 25;           // Tope máximo: 25 SMLMV

// Tasas de cotización — Acuerdo 1152 de 2022 y Ley 1122 de 2007
export const TASAS = {
  salud:   { pct: 0.1250, label: '12.50%' },
  pension: { pct: 0.1600, label: '16.00%' },
  arl: {
    I:   { pct: 0.00522, label: '0.522%' },   // Riesgo mínimo: oficina, comercio
    II:  { pct: 0.01044, label: '1.044%' },   // Riesgo bajo: industria ligera
    III: { pct: 0.02436, label: '2.436%' },   // Riesgo medio
    IV:  { pct: 0.04350, label: '4.350%' },   // Riesgo alto: construcción
    V:   { pct: 0.06960, label: '6.960%' },   // Riesgo máximo: minería
  },
};

// ─── Usuarios mock (reemplazar con API real de AeL en producción) ──────────
const MOCK_USERS: Record<string, UserProfile> = {
  '12345678': {
    cedula: '12345678', name: 'Carlos Rodríguez',
    email: 'carlos.rodriguez@email.com',
    affiliations: { salud: 'Sura EPS', pension: 'Porvenir', arl: 'Positiva', arlClase: 'I' },
  },
  '87654321': {
    cedula: '87654321', name: 'Laura Gómez',
    email: 'laura.gomez@email.com',
    affiliations: { salud: 'Nueva EPS', pension: 'Protección', arl: 'Colmena', arlClase: 'I' },
  },
  '11111111': {
    cedula: '11111111', name: 'Juan Martínez',
    email: 'juan.martinez@email.com',
    affiliations: { salud: 'Compensar', pension: 'Colfondos', arl: 'AXA Colpatria', arlClase: 'I' },
  },
};

// ─── Lookup ────────────────────────────────────────────────────────────────
export function lookupUser(cedula: string): UserProfile | null {
  return MOCK_USERS[cedula] ?? null;
}

// ─── Periodos ──────────────────────────────────────────────────────────────
const MONTH_NAMES = [
  'enero','febrero','marzo','abril','mayo','junio',
  'julio','agosto','septiembre','octubre','noviembre','diciembre',
];
const MONTH_MAP: Record<string, number> = Object.fromEntries(
  MONTH_NAMES.map((m, i) => [m, i + 1])
);

export function currentPeriod(): Period {
  const d = new Date();
  // Aportes de este mes se pagan en los primeros días — sugerimos mes actual
  const m = d.getMonth();
  return {
    month: MONTH_NAMES[m], monthNum: m + 1,
    year: d.getFullYear(),
    display: `${MONTH_NAMES[m]} ${d.getFullYear()}`,
  };
}

export function parsePeriod(text: string): Period | null {
  const t = text.toLowerCase().trim();

  // "junio 2025" | "junio/2025"
  const textMatch = t.match(/^([a-záéíóúü]+)\s*[\/\s]\s*(\d{4})$/);
  if (textMatch) {
    const mNum = MONTH_MAP[textMatch[1]];
    const yr = parseInt(textMatch[2], 10);
    if (mNum && yr >= 2020 && yr <= 2030) {
      return { month: textMatch[1], monthNum: mNum, year: yr, display: `${textMatch[1]} ${yr}` };
    }
  }

  // "06/2025" | "6-2025"
  const numMatch = t.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (numMatch) {
    const mNum = parseInt(numMatch[1], 10);
    const yr = parseInt(numMatch[2], 10);
    if (mNum >= 1 && mNum <= 12 && yr >= 2020 && yr <= 2030) {
      const mName = MONTH_NAMES[mNum - 1];
      return { month: mName, monthNum: mNum, year: yr, display: `${mName} ${yr}` };
    }
  }

  return null;
}

// ─── Cálculo de planilla ───────────────────────────────────────────────────
export function calculatePlanilla(
  profile: UserProfile,
  period: Period,
  monthlyIncome: number
): Planilla {
  const rawIbc = monthlyIncome * 0.4;
  const ibc = Math.round(Math.min(Math.max(rawIbc, SMLMV), MAX_IBC));

  const arlTasa = TASAS.arl[profile.affiliations.arlClase];
  const saludAmt   = Math.round(ibc * TASAS.salud.pct);
  const pensionAmt = Math.round(ibc * TASAS.pension.pct);
  const arlAmt     = Math.round(ibc * arlTasa.pct);

  let ibcFormula: string;
  if (rawIbc < SMLMV) {
    ibcFormula = `mínimo legal (tu 40% da ${fmt(Math.round(rawIbc))}, por debajo de 1 SMLMV)`;
  } else if (rawIbc > MAX_IBC) {
    ibcFormula = `tope de 25 SMLMV aplicado`;
  } else {
    ibcFormula = `40% de ${fmt(monthlyIncome)}`;
  }

  return {
    period, declaredIncome: monthlyIncome, ibc, ibcFormula,
    salud:   { entity: profile.affiliations.salud,   rate: TASAS.salud.label,   amount: saludAmt },
    pension: { entity: profile.affiliations.pension, rate: TASAS.pension.label, amount: pensionAmt },
    arl:     { entity: profile.affiliations.arl,     rate: arlTasa.label,       amount: arlAmt },
    total: saludAmt + pensionAmt + arlAmt,
  };
}

// ─── Formateo ──────────────────────────────────────────────────────────────
export function fmt(n: number): string {
  return '$' + n.toLocaleString('es-CO');
}

export function formatPlanillaMsg(p: Planilla): string {
  return (
    `*Planilla ${p.period.display}*\n\n` +
    `IBC: *${fmt(p.ibc)}* _(${p.ibcFormula})_\n\n` +
    `• Salud — ${p.salud.entity}\n` +
    `  ${p.salud.rate} × ${fmt(p.ibc)} = *${fmt(p.salud.amount)}*\n\n` +
    `• Pensión — ${p.pension.entity}\n` +
    `  ${p.pension.rate} × ${fmt(p.ibc)} = *${fmt(p.pension.amount)}*\n\n` +
    `• ARL — ${p.arl.entity}\n` +
    `  ${p.arl.rate} × ${fmt(p.ibc)} = *${fmt(p.arl.amount)}*\n\n` +
    `────────────────\n` +
    `*Total a pagar: ${fmt(p.total)}*\n\n` +
    `¿Confirmamos y procedemos al pago?`
  );
}

// ─── Pago simulado ─────────────────────────────────────────────────────────
export function mockPaymentLink(): string {
  const token = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `https://pagar.aportesenlinea.com/sim/${token}`;
}

export function mockRadicado(period: Period): string {
  const seq = String(Math.floor(Math.random() * 90000) + 10000);
  return `AEL-${period.year}${String(period.monthNum).padStart(2,'0')}-${seq}`;
}
