import { chromium, Browser, Page } from 'playwright';
import { Period } from './types';

const BASE = 'https://independientes.aportesenlinea.com/Portal/Paginas';

const MES_ABR = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const MES_FULL = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

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
 * Abre el selector "Selecciona el mes que quieres pagar" y fuerza el
 * mes/año exactos del periodo solicitado. Antes el código asumía que el
 * mes cargado por defecto ya era el correcto (y solo reaccionaba si veía
 * "TE ENCUENTRAS RETIRADO"), pero en la práctica el dashboard puede cargar
 * por defecto un mes distinto al pedido — incluso uno que ya está en
 * "ERROR CALCULANDO TUS APORTES" — así que ahora seleccionamos siempre.
 */
async function seleccionarPeriodo(page: Page, period: Period): Promise<void> {
  console.log(`[Scraper] Seleccionando periodo: ${MES_ABR[period.monthNum - 1]} ${period.year}`);

  // Abrir el popup del selector (ícono de calendario o el texto del mes actual)
  const abrirSelector = page.locator(
    'img[src*="cal"], .ui-datepicker-trigger, [id*="calendar"], [id*="Calendar"]'
  ).first();
  await abrirSelector.click().catch(async () => {
    await page.locator('text=Selecciona el mes que quieres pagar').first().click();
  });

  await page.locator('text=Selecciona el año y el mes').waitFor({ timeout: 8_000 });

  const selects = page.locator('select');
  const monthSelect = selects.nth(0);
  const yearSelect = selects.nth(1);

  // Mes: probar abreviatura ("Jul"), luego nombre completo ("Julio"), luego por índice
  let monthSet = false;
  for (const label of [MES_ABR[period.monthNum - 1], MES_FULL[period.monthNum - 1]]) {
    try {
      await monthSelect.selectOption({ label });
      monthSet = true;
      break;
    } catch { /* probar siguiente formato */ }
  }
  if (!monthSet) {
    await monthSelect.selectOption({ index: period.monthNum - 1 });
  }

  // Año: probar por label, luego por value
  try {
    await yearSelect.selectOption({ label: String(period.year) });
  } catch {
    await yearSelect.selectOption({ value: String(period.year) });
  }

  await page.locator('button:has-text("Seleccionar"), input[value="Seleccionar"]').first().click();
  await page.waitForTimeout(1_500);

  // Algunos flujos (ej. "retirado") muestran un botón "Cambiar" para confirmar
  const cambiarBtn = page.locator('button:has-text("Cambiar"), input[value="Cambiar"]');
  if (await cambiarBtn.count() > 0) {
    console.log('[Scraper] Confirmando cambio de periodo con "Cambiar"');
    await cambiarBtn.first().click();
    await page.waitForTimeout(3_000);
  }
}

/**
 * Clic en un locator que puede: (a) actualizar el contenido en la MISMA
 * página vía AJAX/postback (sin cambiar la URL — es el caso real de este
 * portal), (b) abrir un popup/pestaña nueva, o (c) disparar un confirm() que
 * ya viene auto-aceptado por el listener de 'dialog' registrado en la
 * página. En vez de esperar un cambio de URL (que aquí nunca ocurre),
 * esperamos a que aparezca un texto que solo existe en el contenido nuevo.
 */
async function clickAndResolvePage(
  page: Page,
  locatorText: string,
  contentMarker?: string,
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

  if (contentMarker) {
    await page.locator(`text=${contentMarker}`).first().waitFor({ timeout });
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

    // ── Forzar el periodo exacto solicitado (ya no asumimos el default) ────
    await seleccionarPeriodo(page, period);

    await page.locator('text=TOTAL A PAGAR').waitFor({ timeout: 15_000 });
    console.log('[Scraper] Total calculado');

    // ── Clic en Pagar → el portal actualiza el contenido en la MISMA URL ────
    let workPage: Page;
    try {
      workPage = await clickAndResolvePage(page, 'Pagar', 'Pago electrónico', 20_000);
    } catch (e) {
      const openUrls = ctx.pages().map((p) => p.url());
      console.error('[Scraper] Falló la carga de la liquidación tras clic en Pagar. URL actual:', page.url(), 'Páginas abiertas:', openUrls);
      throw e;
    }
    console.log('[Scraper] Liquidación cargada en:', workPage.url());

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
    // OJO: etiquetas como "Salud (EPS)", "Pensión (AFP)" y "Caja de
    // Compensación" aparecen DOS veces en la página: una en "Afiliaciones"
    // (con el nombre de la entidad) y otra en "Pagos" (con el monto en
    // pesos). Como "Pagos" está más abajo en el DOM, usamos .last() para
    // quedarnos con la del monto y no con la del nombre de la entidad.
    async function readAmount(label: string): Promise<number> {
      try {
        const row = workPage.locator(`text=${label}`).last().locator('..');
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
