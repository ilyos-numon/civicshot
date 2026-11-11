import { FACILITY_KO, FAULT_KO, FAULTS, type ComplaintForm, type Fault } from '../../shared/types.ts';

export type FormFacility = keyof typeof FAULTS;

export interface FormInput {
  facility: FormFacility;
  fault: Fault;
  addressLabel: string;
  department: string;
}

/** 시설별 근거 1문장. */
export const REASON: Record<FormFacility, string> = {
  streetlight: '야간 보행 안전에 위험이 있어 신속한 확인을 부탁드립니다.',
  bench: '주민들이 쉬어 가는 곳이라 이용에 불편과 안전 우려가 있어 확인을 부탁드립니다.',
  sidewalk: '보행자가 걸려 넘어질 위험이 있어 신속한 확인을 부탁드립니다.',
};

/** 고장별 상황 설명 1문장 (9개 = facility×fault). */
export const SITUATION: Record<FormFacility, Partial<Record<Fault, string>>> = {
  streetlight: {
    light_out: '가로등이 켜지지 않는 점등 불량 상태입니다.',
    flicker: '가로등 불빛이 계속 깜빡이고 있습니다.',
    pole_damage: '가로등 기둥이 파손되어 기울어져 있습니다.',
  },
  bench: {
    broken: '벤치가 파손되어 앉기 어려운 상태입니다.',
    missing: '있던 벤치가 사라져 분실된 것으로 보입니다.',
    graffiti: '벤치에 낙서와 오염이 심한 상태입니다.',
  },
  sidewalk: {
    broken_block: '보도블록이 깨져 블록 파손 상태입니다.',
    uneven: '보도블록이 들떠 단차가 생겼습니다.',
    hole: '보도에 구멍이 나거나 꺼진 곳이 있습니다.',
  },
};

export function isValidPair(facility: unknown, fault: unknown): facility is FormFacility {
  if (typeof facility !== 'string' || !Object.hasOwn(FAULTS, facility)) return false;
  return (FAULTS[facility as FormFacility] as readonly string[]).includes(fault as string);
}

export function templateForm(input: FormInput): ComplaintForm {
  const fac = FACILITY_KO[input.facility];
  const fault = FAULT_KO[input.fault];
  const title = `[${input.addressLabel}] ${fac} ${fault} 신고`.slice(0, 60);
  const body = [
    `안녕하세요. ${input.department} 담당자님께 ${fac} ${fault} 건으로 신고드립니다.`,
    `위치: ${input.addressLabel}`,
    `${SITUATION[input.facility][input.fault] ?? ''} ${REASON[input.facility]}`.trim(),
    '현장 사진을 첨부했습니다. 확인 후 조치해 주시면 감사하겠습니다.',
  ].join('\n');
  return { title, body, source: 'template' };
}
