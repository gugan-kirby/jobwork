/**
 * Notification rendering against a template version's variable allowlist (doc 11
 * "notification leak", `FR-1005`).
 *
 * The allowlist is a property of the immutable template version, not of the code that
 * fills it: a template that asks for `{{supplierName}}` when its allowlist does not name
 * it refuses to render, and so does a builder that passes a variable the template was
 * never approved to carry. Either way nothing is sent — a missing notification is a bug;
 * a leaked supplier name in a customer's inbox is an incident.
 */

export interface TemplateVersion {
  id: string;
  templateKey: string;
  version: number;
  subject: string;
  body: string;
  variables: string[];
}

export class TemplateRenderRefused extends Error {
  constructor(
    readonly templateKey: string,
    readonly reason: string,
  ) {
    super(`template ${templateKey} refused to render: ${reason}`);
    this.name = 'TemplateRenderRefused';
  }
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;

function fill(template: TemplateVersion, text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_match, name: string) => {
    if (!template.variables.includes(name)) {
      throw new TemplateRenderRefused(template.templateKey, `placeholder {{${name}}} is not in the version ${template.version} allowlist`);
    }
    const value = values[name];
    if (value === undefined) throw new TemplateRenderRefused(template.templateKey, `no value for {{${name}}}`);
    return value;
  });
}

export function render(template: TemplateVersion, values: Record<string, string>): { subject: string; body: string } {
  const outside = Object.keys(values).filter((key) => !template.variables.includes(key));
  if (outside.length > 0) {
    throw new TemplateRenderRefused(template.templateKey, `variables outside the allowlist: ${outside.join(', ')}`);
  }
  return { subject: fill(template, template.subject, values), body: fill(template, template.body, values) };
}
