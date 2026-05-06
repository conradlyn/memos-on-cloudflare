export type Message<T extends string = string> = {
  $typeName?: T;
  [key: string]: unknown;
};

export type GenMessage<T> = { $type: string };
export type GenEnum<T> = { $type: string };
export type GenService = { $type: string };
export type GenFile = unknown;

export function create<T>(_schema: any, data?: Record<string, unknown>): T {
  return (data || {}) as T;
}
