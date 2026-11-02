/** A referenced thread, task, message or artifact does not exist. Presentation maps it to 404. */
export class NotFoundError extends Error {
  readonly entity: string;
  readonly id: string;

  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`);
    this.name = 'NotFoundError';
    this.entity = entity;
    this.id = id;
  }
}

/** The caller may not do this: a tool outside its role, or a run whose task is no longer active. Maps to 403. */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** The input is well-formed but cannot be acted on (for example "request changes" without a comment). Maps to 422. */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}
