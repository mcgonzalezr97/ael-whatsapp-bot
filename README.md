# AeL WhatsApp Bot — MVP v1

Agente conversacional híbrido para pago de seguridad social de independientes vía WhatsApp.

---

## Flujo de datos completo

```
1. Cédula → validación + lookup de perfil
2. Confirmar perfil (nombre + afiliaciones)
3. Confirmar periodo (mes/año de la planilla)
4. Ingresos del mes → cálculo automático IBC
5. Revisar planilla (IBC + desglose SS)
6. Método de pago (PSE / Nequi / Daviplata)
7. Confirmación → radicado + comprobante
```

## Cálculo PILA 2025

| Concepto | Fórmula | Tasa |
|---|---|---|
| IBC | 40% del ingreso declarado, mín. $1.423.500, máx. $35.587.500 | — |
| Salud | IBC × 12.50% | 12.50% |
| Pensión | IBC × 16.00% | 16.00% |
| ARL Clase I | IBC × 0.522% | 0.522% |

SMLMV 2025: **$1.423.500** (Decreto 2737 de 2024)

---

## Instalación

```bash
npm install
cp .env.example .env   # completar con credenciales
```

## Probar localmente (sin WhatsApp)

```bash
npm run test:cli
# Cédulas de prueba: 12345678 · 87654321 · 11111111
```

---

## Despliegue en WhatsApp — paso a paso

### 1. Servidor en Railway

```bash
# 1. Crear repo en GitHub y subir el código
git init && git add . && git commit -m "init"
gh repo create ael-whatsapp-bot --public --push

# 2. Entrar a railway.app → New Project → Deploy from GitHub
#    Seleccionar el repo → Railway auto-detecta Node.js

# 3. En Railway → Variables → agregar todas las del .env.example
#    Railway entrega una URL pública: https://ael-bot-xxx.railway.app
```

### 2. WhatsApp Business API (Meta)

```
1. Ir a developers.facebook.com
2. Crear app → tipo "Business"
3. Agregar producto: WhatsApp
4. En "Configuración de WhatsApp":
   - Copiar el "Token de acceso temporal" → WHATSAPP_TOKEN
   - Copiar el "ID del número de teléfono" → WHATSAPP_PHONE_ID
5. En "Webhook":
   - URL: https://tu-app.railway.app/webhook
   - Token de verificación: el valor que pusiste en WEBHOOK_VERIFY_TOKEN
   - Campos a suscribir: messages
6. Guardar → Meta enviará GET para verificar el webhook
```

### 3. Variables de entorno en Railway

```env
WHATSAPP_TOKEN=        # Token de Meta
WHATSAPP_PHONE_ID=     # ID del número
WEBHOOK_VERIFY_TOKEN=  # Cualquier string que definiste
ANTHROPIC_API_KEY=     # Desde console.anthropic.com
PORT=3000
```

### 4. Probar en WhatsApp

Enviar cualquier mensaje al número de prueba de Meta (aparece en el dashboard de WhatsApp → Primeros pasos).

---

## Estructura del proyecto

```
src/
├── index.ts       # Servidor Express
├── types.ts       # Interfaces TypeScript
├── bot.ts         # Flujo conversacional + webhooks
├── ael.ts         # Cálculos PILA (actualizar SMLMV cada enero)
├── whatsapp.ts    # Cliente WhatsApp Cloud API
├── ai.ts          # Preguntas abiertas con Claude
└── test-cli.ts    # Test local sin WhatsApp
```

## Pasar a producción AeL

Reemplazar en `ael.ts`:
- `MOCK_USERS` → `lookupUser()` con API real de AeL
- `calculatePlanilla()` → validar con motor PILA de AeL
- `mockPaymentLink()` → pasarela de pago real (PSE, Nequi, Daviplata)
- `mockRadicado()` → radicado real generado por AeL

