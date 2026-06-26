export type FlowStep =
  | 'WELCOME'
  | 'AWAITING_CEDULA'
  | 'AWAITING_CONFIRM_PROFILE'
  | 'AWAITING_CONFIRM_PERIOD'
  | 'AWAITING_INCOME'
  | 'AWAITING_CONFIRM_PLANILLA'
  | 'AWAITING_PAYMENT_METHOD'
  | 'AWAITING_PAYMENT_CONFIRM'
  | 'PROCESSING'
  | 'DONE';

export interface Period {
  month: string;    // 'junio'
  monthNum: number; // 6
  year: number;     // 2025
  display: string;  // 'junio 2025'
}

export interface UserProfile {
  cedula: string;
  name: string;
  email: string;
  phone?: string;
  affiliations: {
    salud: string;
    pension: string;
    arl: string;
    arlClase: 'I' | 'II' | 'III' | 'IV' | 'V';
  };
}

export interface Planilla {
  period: Period;
  declaredIncome: number;
  ibc: number;
  ibcFormula: string;   // legible, e.g. "40% de $5.000.000"
  salud:   { entity: string; rate: string; amount: number };
  pension: { entity: string; rate: string; amount: number };
  arl:     { entity: string; rate: string; amount: number };
  total: number;
}

export interface ConversationState {
  phone: string;
  step: FlowStep;
  userProfile?: UserProfile;
  period?: Period;
  declaredIncome?: number;
  planilla?: Planilla;
  pendingPaymentMethod?: string;
  messageHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  lastActivity: number;
}
