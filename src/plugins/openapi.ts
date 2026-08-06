import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

async function openApiPlugin(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Remindly Backend API",
        description: "OCR + Gemini ingestion backend",
        version: "1.0.0"
      },
      servers: [{ url: "http://localhost:8080" }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT"
          }
        }
      }
    }
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs"
  });
}

export default fp(openApiPlugin);
