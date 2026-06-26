import { chromium } from 'playwright';
import { Period } from './types';

const BASE = 'https://independientes.aportesenlinea.com/Portal/Paginas';

export interface ScrapeResult {
  ok: boolean;
  period: string;
  income: number;
  desglose?: {
    ibc: number;
    salud: number;
    pension: number;
    arl: number;
    ccf: number;
    total: number;
  };
  pseLink?: string;
  error?: string;
}

function parseMoney(text: string | null): number {
  if (!text) return 0;
  return parseInt(text.replace(/[^\d]/g, ''), 10) || 0;
}

function fmt(n: number): string {
  return '$' + n.toLocaleString('es-CO');
}

export function formatResultMsg(r: ScrapeResult): string {
  if (!r.ok || !r.desglose) {
    return `Hubo un problema procesando tu planilla: ${r.error}\n\nEscribe *reiniciar* para intentar de nuevo.`;
  }
  const d = r.desglose;
  return (
    `*Planilla ${r.period} — procesada*\n\n` +
    `Ingresos declarados: ${fmt(r.income)}\n` +
    `Base de cotización (IBC): ${fmt(d.ibc)}\n\n` +
    `• Salud: ${fmt(d.salud)}\n` +
    `• Pensión: ${fmt(d.pension)}\n` +
    `• ARL: ${fmt(d.arl)}\n` +
    `• CCF: ${fmt(d.ccf)}\n` +
    `────────────\n` +
    `*Total a pagar: ${fmt(d.total)}*\n\n` +
    `Link de pago PSE:\n${r.pseLink}\n\n` +
    `_Válido por 15 minutos. Completa el pago en tu banco._`
  );
}

export async function procesarPlanilla(
  income: number,
  period: Period
): Promise<ScrapeResult> {
  const cedula   = process.env.AEL_CEDULA!;
  const password = process.env.AEL_PASSWORD!;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const ctx  = await browser.newContext({ locale: 'es-CO' });
  const page = await ctx.newPage();

  try {
    console.log('[Scraper] Iniciando login...');

    // ── Paso 1: cédula ────────────────────────────────────────────────────
    await page.goto(`${BASE}/Home.aspx`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('input[placeholder*="documento"]').fill(cedula);
    await page.locator('button:has-text("Continuar")').first().click();

    // ── Paso 2: contraseña ────────────────────────────────────────────────
    await page.locator('input[type="password"]').waitFor({ timeout: 10_000 });
    await page.locator('input[type="password"]').fill(password);
    await page.locator('button:has-text("Continuar")').first().click();

    // ── Dashboard ─────────────────────────────────────────────────────────
    await page.waitForURL('**dashboard**', { timeout: 20_000 });
    console.log('[Scraper] Dashboard cargado');

    // Esperar que el total se calcule
    await page.locator('text=TOTAL A PAGAR').waitFor({ timeout: 10_000 });

    // ── Clic en Pagar ─────────────────────────────────────────────────────
    await page.locator('text=Pagar').first().click();
    await page.waitForURL('**PagoLiquidacion**', { timeout: 15_000 });
    console.log('[Scraper] Página de liquidación cargada');

    // ── Editar ingresos ───────────────────────────────────────────────────
    // El último botón Editar corresponde a la sección Pagos
    await page.locator('text=Ingresos').first().waitFor({ timeout: 8_000 });
    const editarBtns = page.locator('a:has-text("Editar"), button:has-text("Editar")');
    const count = await editarBtns.count();
    await editarBtns.nth(count - 1).click();
    console.log('[Scraper] Editar ingresos clickeado');

    await page.waitForTimeout(1_500);

    // ── Ingresar monto ────────────────────────────────────────────────────
    // Buscar el campo de ingresos — puede ser type number o text visible
    const inputSelectors = [
      'input[type="number"]:visible',
      'input[placeholder*="ingreso"]:visible',
      'input[placeholder*="Ingreso"]:visible',
      'input[placeholder*="valor"]:visible',
      'input[type="text"]:visible',
    ];

    let filled = false;
    for (const sel of inputSelectors) {
      const inp = page.locator(sel).first();
      if (await inp.count() > 0) {
         // select all
        await inp.selectText();
      await inp.fill(income.toString());
        filled = true;
        console.log(`[Scraper] Ingreso llenado con selector: ${sel}`);
        break;
      }
    }

    if (!filled) throw new Error('No se encontró el campo de ingresos');

    // Guardar / Calcular
    const saveBtns = [
      'button:has-text("Guardar")',
      'button:has-text("Calcular")',
      'button:has-text("Actualizar")',
      'button:has-text("Aceptar")',
      'input[type="submit"]',
    ];

    let saved = false;
    for (const sel of saveBtns) {
      if (await page.locator(sel).count() > 0) {
        await page.locator(sel).first().click();
        saved = true;
        break;
      }
    }
    if (!saved) await page.keyboard.press('Enter');

    await page.waitForTimeout(2_500);
    console.log('[Scraper] Ingresos guardados');

    // ── Leer desglose ─────────────────────────────────────────────────────
    async function readAmount(label: string): Promise<number> {
      try {
        const row = page.locator(`text=${label}`).first().locator('..');
        const text = await row.textContent();
        return parseMoney(text);
      } catch {
        return 0;
      }
    }

    const ibc     = await readAmount('Base de cotización');
    const salud   = await readAmount('Salud (EPS)');
    const pension = await readAmount('Pensión (AFP)');
    const arl     = await readAmount('Riesgos Laborales');
    const ccf     = await readAmount('Caja de Compensación');
    const total   = await readAmount('Total a pagar');

    console.log('[Scraper] Desglose leído:', { ibc, salud, pension, arl, ccf, total });

    // ── Clic en Pago electrónico → capturar link PSE ──────────────────────
    let pseLink = '';

    // Escuchar nueva pestaña
    const newPagePromise = ctx.waitForEvent('page', { timeout: 12_000 }).catch(() => null);
    await page.locator('text=Pago electrónico').first().click();

    const newTab = await newPagePromise;
    if (newTab) {
      await newTab.waitForLoadState('domcontentloaded', { timeout: 15_000 });
      pseLink = newTab.url();
      console.log('[Scraper] PSE link (nueva pestaña):', pseLink);
    } else {
      await page.waitForTimeout(3_000);
      pseLink = page.url();
      console.log('[Scraper] PSE link (misma pestaña):', pseLink);
    }

    return { ok: true, period: period.display, income, desglose: { ibc, salud, pension, arl, ccf, total }, pseLink };

  } catch (err) {
    console.error('[Scraper] Error:', err);
    await page.screenshot({ path: '/tmp/ael-error.png', fullPage: true }).catch(() => {});
    return {
      ok: false,
      period: period.display,
      income,
      error: err instanceof Error ? err.message : 'Error desconocido en la plataforma de AeL',
    };
  } finally {
    await browser.close();
  }
}
