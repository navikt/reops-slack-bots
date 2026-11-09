# Domain context

- **Thread**: original user message and its replies in a source Slack channel.
- **Handled**: latest relevant signal is a team reply, configured handled
  reaction, or a manual Suppress action. Later non-team activity can reopen it.
- **Assignment**: routing of an open thread to one teammate. Assignment itself
  is not a handled signal.
- **Reminder**: a request to act on an open thread, subject to grace and cooldown.
- **Delivery**: a posted bot message showing one or more thread previews, either
  in the team channel or an assignee's DM. Delivery location does not change the
  thread's handled rule.
- **Thread snapshot**: cached preview from Slack, shared by all deliveries. Slack
  remains authoritative for message content, replies, and reactions; the DB
  holds manual actions and delivery bookkeeping.
