"use client";

import SwaggerUI from "swagger-ui-react";
import "swagger-ui-react/swagger-ui.css";
import "./swagger-ui-overrides.css";

/** Its own chunk: Swagger UI is over a megabyte, and the page around it shouldn't wait for it. */
export default function SwaggerPanel() {
  return <SwaggerUI url="/api/v1/openapi.json" deepLinking defaultModelsExpandDepth={1} />;
}
