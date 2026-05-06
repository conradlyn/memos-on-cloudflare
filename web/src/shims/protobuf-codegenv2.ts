export function fileDesc(..._args: any[]): any {
  return {};
}

export function messageDesc(..._args: any[]): any {
  return { $type: "message" };
}

export function enumDesc(..._args: any[]): any {
  return { $type: "enum" };
}

export function serviceDesc(..._args: any[]): any {
  return { $type: "service" };
}

export function extDesc(..._args: any[]): any {
  return { $type: "extension" };
}

export type GenFile = unknown;
export type GenMessage<T> = { $type: string };
export type GenEnum<T> = { $type: string };
export type GenService = { $type: string };
export type GenExtension<T, U> = { $type: string };
