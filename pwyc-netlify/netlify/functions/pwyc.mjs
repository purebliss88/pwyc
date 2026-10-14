// Pay What You Can endpoint. Lives at  https://YOUR-SITE.netlify.app/pwyc
import { handleRequest } from "../lib/pwyc-core.mjs";

export default async (request) => handleRequest(request, process.env);

export const config = { path: "/pwyc" };
