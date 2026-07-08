import { chromium, Browser, Page } from 'playwright';
import { Period } from './types';

const BASE = 'https://independientes.aportesenlinea.com/Portal/Paginas';

export interface ScrapeResult {
  ok: boolean;
  period: string;
  income: number;
  desglose?: { ibc: number; salud: number; pension: number; arl: number; ccf: number; total: number };
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

/**
 * Clic en un locator que puede: (a) navegar la misma página, (b) abrir un
 * popup/pestaña nueva, o (c) disparar un confirm() que ya viene auto-aceptado
 * por el listener de 'dialog' registrado en la página. Devuelve la página
 * "activa" a usar para los pasos siguientes.
 */
async function clickAndResolvePage(
  page: Page,
  locatorText: string,
  urlPattern?: string,
  timeout = 20_000
): Promise<Page> {
  const ctx = page.context();
  const popupPromise = ctx.waitForEvent('page', { timeout: 4_000 }).catch(() => null);

  await page.locator(`text=${locatorText}`).first().click();

  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
    console.log(`[Scraper] "${locatorText}" abrió una pestaña nueva: ${popup.url()}`);
    return popup;
  }

  if (urlPattern) {
    await page.waitForURL(urlPattern, { timeout });
  }
  return page;
}

export async function procesarPlanilla(income: number, period: Period): Promise<ScrapeResult> {
  const cedula   = process.env.AEL_CEDULA ?? '';
  const password = process.env.AEL_PASSWORD ?? '';

  if (!cedula || !password) {
    return { ok: false, period: period.display, income, error: 'Credenciales AeL no configuradas (AEL_CEDULA / AEL_PASSWORD)' };
  }

  let browser: Browser | null = null;
  let page: Page;

  try {
    console.log('[Scraper] Lanzando Chromium...');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
    });

    const ctx = await browser.newContext({ locale: 'es-CO' });
    page = await ctx.newPage();

    // ── Auto-aceptar cualquier confirm()/alert() del portal ────────────────
    // Sin este listener, Playwright descarta (cancela) los diálogos por
    // defecto, lo que puede bloquear silenciosamente cualquier navegación
    // que dependa de un "¿Deseas continuar?" tipo confirm().
    ctx.on('page', (p) => {
      p.on('dialog', async (dialog) => {
        console.log(`[Scraper] Dialog (${dialog.type()}): ${dialog.message()}`);
        await dialog.accept().catch(() => {});
      });
    });
    page.on('dialog', async (dialog) => {
      console.log(`[Scraper] Dialog (${dialog.type()}): ${dialog.message()}`);
      await dialog.accept().catch(() => {});
    });

    // ── Login paso 1: cédula ──────────────────────────────────────────────
    console.log('[Scraper] Navegando al login...');
    await page.goto(`${BASE}/Home.aspx`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('input[placeholder*="documento"]').fill(cedula);
    await page.locator('button:has-text("Continuar"), a:has-text("Continuar"), input[value*="Continuar"]').first().click();

    // ── Login paso 2: contraseña ──────────────────────────────────────────
    await page.locator('input[type="password"]').waitFor({ timeout: 10_000 });
    await page.locator('input[type="password"]').fill(password);
    await page.locator('button:has-text("Continuar"), a:has-text("Continuar"), input[value*="Continuar"]').first().click();

    // ── Dashboard ─────────────────────────────────────────────────────────
    await page.waitForURL(/Dashboard/i, { timeout: 20_000 });
    console.log('[Scraper] Dashboard cargado');
    await page.waitForTimeout(2_000);

    // ── Corregir estado "Retirado" si aplica ──────────────────────────────
    const retirado = await page.locator('text=TE ENCUENTRAS RETIRADO').count();
    if (retirado > 0) {
      console.log('[Scraper] Estado retirado — corrigiendo mes...');
      await page.locator('img[src*="cal"], .ui-datepicker-trigger, [id*="calendar"], [id*="Calendar"]').first().click().catch(async () => {
        await page.locator('input:near(:text("Nueva fecha de ingreso")) + img, input:near(:text("Nueva fecha")) ~ img').first().click();
      });
      await page.waitForTimeout(1_000);
      await page.locator('button:has-text("Seleccionar"), input[value="Seleccionar"]').first().click();
      await page.waitForTimeout(500);
      await page.locator('button:has-text("Cambiar"), input[value="Cambiar"]').first().click();
      await page.waitForTimeout(4_000);
    }

    await page.locator('text=TOTAL A PAGAR').waitFor({ timeout: 15_000 });
    console.log('[Scraper] Total calculado');

    // ── Clic en Pagar → puede navegar, abrir pestaña, o pasar por un confirm() ──
    let workPage: Page;
    try {
      workPage = await clickAndResolvePage(page, 'Pagar', '**PagoLiquidacion**', 20_000);
    } catch (e) {
      // Diagnóstico extra si sigue fallando: URL actual + páginas abiertas
      const openUrls = ctx.pages().map((p) => p.url());
      console.error('[Scraper] Falló navegación a PagoLiquidacion. URL actual:', page.url(), 'Páginas abiertas:', openUrls);
      throw e;
    }
    console.log('[Scraper] Página de liquidación cargada:', workPage.url());

    // ── Editar ingresos ───────────────────────────────────────────────────
    await workPage.locator('text=Ingresos').first().waitFor({ timeout: 8_000 });
    const editarBtns = workPage.locator('a:has-text("Editar"), button:has-text("Editar")');
    const count = await editarBtns.count();
    await editarBtns.nth(count - 1).click();
    console.log('[Scraper] Editar ingresos clickeado');
    await workPage.waitForTimeout(1_500);

    // ── Ingresar monto ────────────────────────────────────────────────────
    const inputSelectors = [
      'input[type="number"]:visible',
      'input[placeholder*="ngreso"]:visible',
      'input[placeholder*="alor"]:visible',
      'input[type="text"]:visible',
    ];

    let filled = false;
    for (const sel of inputSelectors) {
      const inp = workPage.locator(sel).first();
      if (await inp.count() > 0) {
        await inp.selectText();
        await inp.fill(income.toString());
        filled = true;
        console.log(`[Scraper] Ingreso llenado: ${sel}`);
        break;
      }
    }
    if (!filled) throw new Error('No se encontró el campo de ingresos tras hacer clic en Editar');

    // Guardar
    for (const sel of ['button:has-text("Guardar")', 'button:has-text("Calcular")', 'button:has-text("Actualizar")', 'input[type="submit"]']) {
      if (await workPage.locator(sel).count() > 0) {
        await workPage.locator(sel).first().click();
        break;
      }
    }
    await workPage.waitForTimeout(2_500);
    console.log('[Scraper] Ingresos guardados');

    // ── Leer desglose ─────────────────────────────────────────────────────
    async function readAmount(label: string): Promise<number> {
      try {
        const row = workPage.locator(`text=${label}`).first().locator('..');
        return parseMoney(await row.textContent());
      } catch { return 0; }
    }

    const ibc     = await readAmount('Base de cotización');
    const salud   = await readAmount('Salud (EPS)');
    const pension = await readAmount('Pensión (AFP)');
    const arl     = await readAmount('Riesgos Laborales');
    const ccf     = await readAmount('Caja de Compensación');
    const total   = await readAmount('Total a pagar');
    console.log('[Scraper] Desglose:', { ibc, salud, pension, arl, ccf, total });

    // ── Pago electrónico → capturar PSE ───────────────────────────────────
    let pseLink = '';
    const newPagePromise = ctx.waitForEvent('page', { timeout: 12_000 }).catch(() => null);
    await workPage.locator('text=Pago electrónico').first().click();

    const newTab = await newPagePromise;
    if (newTab) {
      await newTab.waitForLoadState('domcontentloaded', { timeout: 15_000 });
      pseLink = newTab.url();
    } else {
      await workPage.waitForTimeout(3_000);
      pseLink = workPage.url();
    }
    console.log('[Scraper] PSE link:', pseLink);

    return { ok: true, period: period.display, income, desglose: { ibc, salud, pension, arl, ccf, total }, pseLink };

  } catch (err) {
    console.error('[Scraper] Error:', err instanceof Error ? err.message : err);
    return { ok: false, period: period.display, income, error: err instanceof Error ? err.message : 'Error desconocido' };
  } finally {
    if (browser) await browser.close();
  }
}
