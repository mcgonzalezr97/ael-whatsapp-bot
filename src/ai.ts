import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const SYSTEM_PROMPT = `Eres el asistente virtual de Aportes en Línea (AeL), la plataforma colombiana de pago de seguridad social para trabajadores independientes.

Tu rol es responder preguntas abiertas sobre seguridad social, PILA, IBC y pagos en Colombia. Eres amable, directo y claro.

Reglas:
- Responde en máximo 2-3 oraciones. Sé conciso.
- Usa lenguaje simple, sin jerga técnica innecesaria.
- Si el usuario pregunta cuánto debe pagar o cómo calcular el IBC, explica brevemente la fórmula: IBC = 40% de los ingresos mensuales, mínimo 1 SMLMV ($1.300.000 en 2024).
- Si no sabes algo con certeza, indícale al usuario que puede hablar con un asesor.
- No inventes información regulatoria ni cifras que no tengas.
- Termina siempre con una invitación a continuar con el flujo de pago.

Contexto Colombia:
- SMLMV 2024: $1.300.000
- Aportes independiente: Salud 12.5% + Pensión 16% + ARL 0.52% (Clase I) sobre el IBC
- El IBC para independientes es el 40% del ingreso mensual, mínimo 1 SMLMV`;

export async function getAIResponse(
  question: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<string> {
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [
        ...history.slice(-6), // Últimos 3 turnos para contexto
        { role: 'user', content: question },
      ],
    });

    return response.content[0].type === 'text'
      ? response.content[0].text
      : '¿Continuamos con tu pago de seguridad social?';
  } catch (err) {
    console.error('AI error:', err);
    return 'No pude procesar tu pregunta en este momento. ¿Continuamos con tu pago?';
  }
}
