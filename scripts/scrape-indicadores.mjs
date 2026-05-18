/**
 * Lee los indicadores previsionales desde PREVIRED y los guarda en
 * assets/indicadores.json. Lo ejecuta a diario GitHub Actions.
 *
 * Sin dependencias: usa fetch nativo de Node y parseo por expresiones
 * regulares. Si algo no se puede leer o un valor queda fuera de rango,
 * lanza un error y NO sobrescribe el JSON anterior.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_PREVIRED = 'https://www.previred.com/indicadores-previsionales/';
const __dirname = dirname(fileURLToPath(import.meta.url));
const SALIDA = join(__dirname, '..', 'assets', 'indicadores.json');

/* Porcentajes y valores pequeños: la coma (o el punto) es separador decimal. */
const pct = s => parseFloat(String(s).replace(',', '.'));
/* Montos en pesos: el punto es separador de miles, la coma es decimal. */
const money = s => parseFloat(String(s).replace(/\./g, '').replace(',', '.'));

/* Devuelve cada <table> de la pagina como texto plano (sin etiquetas). */
function leerTablas(html) {
  const limpio = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  return [...limpio.matchAll(/<table[\s\S]*?<\/table>/gi)].map(m =>
    m[0]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#8211;/g, '-')
      .replace(/&[#a-z0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/* Busca la primera tabla que contiene una palabra clave (solo ASCII). */
function tablaCon(tablas, clave) {
  const t = tablas.find(x => x.toUpperCase().includes(clave.toUpperCase()));
  if (!t) throw new Error('No se encontro la tabla con: ' + clave);
  return t;
}

function extraer(texto, regex, etiqueta) {
  const m = texto.match(regex);
  if (!m) throw new Error('No se pudo leer: ' + etiqueta);
  return m;
}

function validarRango(valor, min, max, nombre) {
  if (typeof valor !== 'number' || Number.isNaN(valor) || valor < min || valor > max) {
    throw new Error(`Valor fuera de rango: ${nombre} = ${valor}`);
  }
}

async function main() {
  const resp = await fetch(URL_PREVIRED, {
    headers: { 'User-Agent': 'Mozilla/5.0 (GriffinAsesores indicadores bot)' }
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' al pedir PREVIRED');

  const tablas = leerTablas(await resp.text());
  if (tablas.length < 8) {
    throw new Error('Estructura inesperada: solo ' + tablas.length + ' tablas');
  }

  /* UF */
  const tUF = tablaCon(tablas, 'VALOR UF');
  const uf = money(extraer(tUF, /\$\s*([\d.,]+)/, 'UF')[1]);
  const ufFecha = (tUF.match(/Al\s+(\d+\s+de\s+\w+\s+del?\s+\d{4})/i) || [])[1] || null;

  /* UTM */
  const tUTM = tablaCon(tablas, 'VALOR UTM');
  const utm = money(extraer(tUTM, /\$\s*([\d.,]+)/, 'UTM')[1]);

  /* Topes imponibles (en UF). Orden en la tabla: AFP, IPS, Cesantia. */
  const tTopes = tablaCon(tablas, 'TOPES IMPONIBLES');
  const topesUF = [...tTopes.matchAll(/\(([\d.,]+)\s*UF\)/gi)].map(m => pct(m[1]));
  if (topesUF.length < 2) throw new Error('No se pudieron leer los topes imponibles');
  const topeAfpUF = topesUF[0];
  const topeCesantiaUF = topesUF[topesUF.length - 1];

  /* SIS */
  const tSIS = tablaCon(tablas, '(SIS)');
  const sis = pct(extraer(tSIS, /([\d.,]+)\s*%/, 'SIS')[1]);

  /* Seguro Social (reforma previsional) */
  const tSS = tablaCon(tablas, 'SEGURO SOCIAL');
  const seguroSocial = pct(extraer(tSS, /([\d.,]+)\s*%/, 'Seguro Social')[1]);

  /* Renta minima imponible */
  const tRM = tablaCon(tablas, 'RENTAS M');
  const rentaMinima = money(extraer(tRM, /\$\s*([\d.,]+)/, 'Renta minima')[1]);

  /* AFP: tasa de cotizacion (cargo trabajador y cargo empleador). */
  const tAFP = tablaCon(tablas, 'CARGO DEL EMPLEADOR');
  const nombresAFP = ['Capital', 'Cuprum', 'Habitat', 'PlanVital', 'ProVida', 'Modelo', 'Uno'];
  const afp = {};
  for (const nombre of nombresAFP) {
    const m = extraer(
      tAFP,
      new RegExp(nombre + '\\s+([\\d.,]+)\\s*%\\s+([\\d.,]+)\\s*%'),
      'AFP ' + nombre
    );
    afp[nombre] = { trabajador: pct(m[1]), empleador: pct(m[2]) };
  }

  /* Periodo al que corresponden las remuneraciones */
  const periodo = (tablas[0].match(/remuneraciones\s+([a-zA-Z]+\s+\d{4})/i) || [])[1] || null;

  const datos = {
    actualizado: new Date().toISOString(),
    fuente: 'previred.com/indicadores-previsionales',
    periodo: periodo ? 'remuneraciones ' + periodo : null,
    uf,
    ufFecha,
    utm,
    topeAfpUF,
    topeCesantiaUF,
    sis,
    seguroSocial,
    rentaMinima,
    afp
  };

  /* Validacion: si algo quedo raro, falla y se conserva el JSON anterior. */
  validarRango(datos.uf, 30000, 90000, 'uf');
  validarRango(datos.utm, 50000, 150000, 'utm');
  validarRango(datos.topeAfpUF, 60, 160, 'topeAfpUF');
  validarRango(datos.topeCesantiaUF, 100, 260, 'topeCesantiaUF');
  validarRango(datos.sis, 0.5, 4, 'sis');
  validarRango(datos.seguroSocial, 0, 6, 'seguroSocial');
  validarRango(datos.rentaMinima, 300000, 1500000, 'rentaMinima');
  for (const [n, a] of Object.entries(datos.afp)) {
    validarRango(a.trabajador, 10, 16, 'afp ' + n + ' trabajador');
    validarRango(a.empleador, 0, 6, 'afp ' + n + ' empleador');
  }

  mkdirSync(dirname(SALIDA), { recursive: true });
  writeFileSync(SALIDA, JSON.stringify(datos, null, 2) + '\n', 'utf-8');
  console.log('OK - indicadores.json actualizado:\n' + JSON.stringify(datos, null, 2));
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
