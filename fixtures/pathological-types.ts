type TupleOf<T, N extends number, R extends T[] = []> = R["length"] extends N
  ? R
  : TupleOf<T, N, [...R, T]>;

type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};

type ApiEnvelope<T> =
  | { ok: true; data: DeepReadonly<T>; meta: { cached: boolean; tags: string[] } }
  | { ok: false; error: { code: string; retryAfter?: number } };

type HugeUnion =
  | { kind: "alpha"; value: TupleOf<string, 8> }
  | { kind: "beta"; value: TupleOf<number, 12> }
  | { kind: "gamma"; value: TupleOf<boolean, 16> }
  | { kind: "delta"; value: TupleOf<Date, 20> };

export type PathologicalResult = ApiEnvelope<{
  user: {
    id: string;
    profile: {
      name: string;
      roles: HugeUnion[];
    };
  };
  permissions: Record<string, HugeUnion>;
}>;

export const sample: PathologicalResult = {
  ok: true,
  data: {
    user: {
      id: "u_123",
      profile: {
        name: "Ada",
        roles: [{ kind: "alpha", value: ["a", "b", "c", "d", "e", "f", "g", "h"] }]
      }
    },
    permissions: {}
  },
  meta: {
    cached: false,
    tags: ["fixture"]
  }
};
