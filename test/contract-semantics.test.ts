import { expect, it } from "bun:test";
import {
  buildOperation,
  contractSemanticDrift,
  type ReviewedRoute,
} from "../scripts/contract-semantics";

const route: ReviewedRoute = {
  family: "product",
  suffix: "/",
  shape: "page",
  query: "page",
  responseFamily: "product",
};

it("ignores prose and parameter ordering when route semantics agree", () => {
  const operation = buildOperation("/products", route);
  if (!operation.parameters) throw new Error("expected query parameters");
  const reversedParameters = [...operation.parameters].reverse();
  const contractPaths = {
    "/products": {
      get: {
        ...operation,
        summary: "Edited prose",
        parameters: reversedParameters.map((parameter) => ({
          ...parameter,
          description: "Edited prose",
        })),
      },
    },
  };

  expect(
    contractSemanticDrift(new Map([["/products", route]]), contractPaths),
  ).toEqual([]);
});

it("reports every missing, extra, and changed route semantic deterministically", () => {
  const operation = buildOperation("/products", route);
  const changedOperation = structuredClone(operation);
  if (!changedOperation.parameters)
    throw new Error("expected query parameters");
  const limit = changedOperation.parameters.find(
    (parameter) => parameter.name === "limit",
  );
  if (!limit) throw new Error("expected limit parameter");
  limit.schema = { type: "string" };

  const reviewed = new Map([
    ["/missing", { ...route, suffix: "/missing" }],
    ["/products", route],
  ]);
  const drift = contractSemanticDrift(reviewed, {
    "/extra": { get: operation },
    "/products": { get: changedOperation },
  });

  expect(drift[0]).toBe("missing: GET /missing");
  expect(drift[1]).toBe("extra: GET /extra");
  expect(drift[2]).toStartWith("changed: GET /products");
  expect(drift[2]).toContain('"name":"limit"');
  expect(drift[2]).toContain('"type":"string"');
});

it("reports non-GET operations as changed semantics", () => {
  const drift = contractSemanticDrift(new Map([["/products", route]]), {
    "/products": { get: buildOperation("/products", route), post: {} },
  });

  expect(drift).toEqual([
    'changed: GET /products operations expected ["get"], found ["get","post"]',
  ]);
});

it("reports additional success media types as changed semantics", () => {
  const operation = structuredClone(buildOperation("/products", route));
  const content = operation.responses[200].content as Record<
    string,
    { schema: unknown }
  >;
  content["text/plain"] = { schema: { type: "string" } };

  const drift = contractSemanticDrift(new Map([["/products", route]]), {
    "/products": { get: operation },
  });

  expect(drift).toHaveLength(1);
  expect(drift[0]).toContain('"mediaTypes":["application/json","text/plain"]');
});
