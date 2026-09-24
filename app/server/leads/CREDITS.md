# Credits

- **OpenOutreach** (GPL): a separate program the founder runs on this machine through `uvx openoutreach`. The app
  only starts it and reads the CSV it prints. None of its code is in this repository, and nothing of it is bundled.
- **Twenty** (AGPL-3.0, with its "Twenty Application Exception" for programs that use only its published APIs): the
  Leads card borrows its data model (a person, their company, notes, a stage) as an idea. When the founder connects
  their own Twenty, `app/server/leads/twenty.ts` talks to it over its public REST and metadata APIs, as an API
  client, which the exception covers. None of Twenty's code or text is in this repository, nothing of it is
  bundled, and the app never runs a Twenty service: the founder runs their own, from Twenty's own images.
