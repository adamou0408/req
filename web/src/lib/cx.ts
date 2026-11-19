/** 把 class 名稱接起來，略過 false、null、undefined。 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
