import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const SYSTEM_PROMPT = `Eres el asistente virtual de Aportes en Línea (AeL), plataforma colombiana de pago de seguridad social para trabajadores independientes.

SOLO puedes responder preguntas sobre estos temas:
- Seguridad social en Colombia (salud, pensión, ARL)
- Sistema PILA y planillas de pago
- IBC (Ingreso Base de Cotización)
- Afiliaciones a EPS, AFP y ARL
- Fechas y obligaciones de pago para independientes
- SMLMV y cálculos de aportes
- Trámites relacionados con Aportes en Línea

Si el usuario pregunta sobre cualquier otro tema responde exactamente esto:
"Solo puedo ayudarte con temas de seguridad social y pago de aportes. ¿Tienes alguna duda sobre tu planilla?"

Reglas adicionales:
- Responde en máximo 2 oraciones.
- Usa lenguaje simple, sin tecnicismos innecesarios.
- Termina siempre invitando a continuar con el pago.
- SMLMV 2026: $1.750.905. IBC independientes: 40% del ingreso, mínimo 1 SMLMV.`;

export async function getAIResponse(
  question: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<string> {
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      system: SYSTEM_PROMPT,
      messages: [
        ...history.slice(-4),
        { role: 'user', content: question },
      ],
    });

    return response.content[0].type === 'text'
      ? response.content[0].text
      : '¿Continuamos con tu planilla?';
  } catch (err) {
    console.error('AI error:', err);
    return '¿Continuamos con tu planilla?';
  }
}
