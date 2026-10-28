/*
 * The three states a subscriber's template binding can be in.
 *
 * A binding is a name, not a foreign key: the template it points at can be
 * deleted, and the catalog that would resolve it arrives asynchronously. Both
 * surfaces that show a binding (the list row and the detail card) must agree on
 * what "bound", "dangling" and "not yet resolvable" mean, so the classification
 * lives here once instead of being re-derived per component.
 */
export type TemplateOption = { name: string; title?: string };

export type TemplateBindingState = 'unbound' | 'pending' | 'bound' | 'dangling';

export type TemplateBinding = {
  state: TemplateBindingState;
  name: string;
  template: TemplateOption | undefined;
};

export function resolveTemplateBinding(
  binding: string | null | undefined,
  profiles: TemplateOption[],
  profilesReady: boolean,
): TemplateBinding {
  const name = String(binding ?? '').trim();
  if (!name) return { state: 'unbound', name, template: undefined };

  const template = profiles.find((entry) => entry.name === name);
  if (template) return { state: 'bound', name, template };

  /* An unresolved name is not a missing template while the catalog is still
   * loading: claiming "deleted" before the answer arrives is a false accusation. */
  return profilesReady
    ? { state: 'dangling', name, template: undefined }
    : { state: 'pending', name, template: undefined };
}
