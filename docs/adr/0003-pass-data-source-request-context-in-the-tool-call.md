# Pass data source request context in the tool call

`dataSourceBaseUrl` is the only data-source request context supplied by the model. It resolves relative `dataSource.endpoint` values because Pi CLI has no browser origin. A relative endpoint without it returns a recoverable argument error with correct single-question and grouped-question retry examples.

This decision is superseded for credentials: headers and cookies are not model-visible. Authentication rules live in `ask-user-question.auth.json` under the Pi agent directory and map normalized origins plus optional path prefixes to environment-variable names. Values are read at request time, authenticated plain HTTP is restricted to loopback, and redirects cannot carry credentials across origins. Transport or parsing failures remain field-local so the user can retry without terminating the tool call.
