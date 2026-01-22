export const fetchWrapper = async (url: string, options?: RequestInit) => {
  return fetch(url, options);
};

export { fetchJson, ApiClientError } from "@/lib/api/fetchJson";

