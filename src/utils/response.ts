import type { FastifyReply } from "fastify";

export interface SuccessResponse<T> {
  status: "success";
  message?: string;
  data: T;
}

export interface ErrorResponse {
  status: "error";
  error_code: string;
  message: string;
  details?: unknown;
}

export interface PaginationMeta {
  current_page: number;
  per_page: number;
  total_items: number;
  total_pages: number;
}

export interface PaginatedResponse<T> {
  status: "success";
  message?: string;
  data: T[];
  meta: PaginationMeta;
}

export type ApiResponse<T> = SuccessResponse<T> | ErrorResponse;

export function sendSuccess<T>(
  reply: FastifyReply,
  data: T,
  message?: string,
  statusCode = 200,
): void {
  reply.code(statusCode).send({ status: "success", message, data } as SuccessResponse<T>);
}

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  errorCode: string,
  message: string,
  details?: unknown,
): void {
  reply.code(statusCode).send({ status: "error", error_code: errorCode, message, details } as ErrorResponse);
}

export function sendPaginated<T>(
  reply: FastifyReply,
  data: T[],
  currentPage: number,
  perPage: number,
  totalItems: number,
  message?: string,
): void {
  reply.code(200).send({
    status: "success",
    message,
    data,
    meta: {
      current_page: currentPage,
      per_page: perPage,
      total_items: totalItems,
      total_pages: Math.ceil(totalItems / perPage),
    },
  } as PaginatedResponse<T>);
}
