"""Static text checks only. Never connects to a database or executes SQL."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
FILES = sorted((ROOT / "migrations").glob("*.sql"))
TABLES = {"user_settings", "categories", "tasks", "task_occurrences", "task_activity"}


def statements(source):
    """Small lexical scanner, NOT a PostgreSQL/PLpgSQL parser."""
    result, chunk, position, depth = [], [], 0, 0
    while position < len(source):
        if source.startswith("--", position):
            end = source.find("\n", position)
            position = len(source) if end == -1 else end
            chunk.append(" ")
        elif source.startswith("/*", position):
            end = source.find("*/", position + 2)
            assert end != -1, "Unterminated block comment"
            position = end + 2
            chunk.append(" ")
        elif source[position] in "'\"":
            quote, start = source[position], position
            position += 1
            while position < len(source):
                if source[position] == quote:
                    if position + 1 < len(source) and source[position + 1] == quote:
                        position += 2
                        continue
                    position += 1
                    break
                position += 1
            else:
                raise AssertionError("Unterminated quoted string/identifier")
            chunk.append(source[start:position])
        elif source[position] == "$" and (match := re.match(r"\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$", source[position:])):
            delimiter, start = match.group(), position
            end = source.find(delimiter, position + len(delimiter))
            assert end != -1, "Unterminated dollar body"
            position = end + len(delimiter)
            chunk.append(source[start:position])
        else:
            char = source[position]
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                assert depth >= 0, "Unbalanced SQL parentheses"
            if char == ";":
                assert depth == 0, "Semicolon inside unfinished outer parentheses"
                result.append("".join(chunk).strip())
                chunk = []
            else:
                chunk.append(char)
            position += 1
    assert depth == 0, "Unbalanced SQL parentheses"
    assert not "".join(chunk).strip(), "Missing final SQL semicolon"
    return result


def main():
    assert len(FILES) == 2, "Unexpected migration inventory"
    sources = [path.read_text() for path in FILES]
    sql = "\n".join(sources)
    all_statements = []
    public_functions = set()
    private_definers = set()
    for path, source in zip(FILES, sources):
        assert "DRAFT / DESIGN ONLY" in source, f"Missing draft marker: {path.name}"
        parts = statements(source)
        assert parts[0].lower() == "begin" and parts[-1].lower() == "commit"
        all_statements.extend(parts)
    tables = set(re.findall(r"create table public\.(\w+)", sql, re.I))
    assert tables == TABLES, "Unexpected table inventory"
    for table in TABLES:
        for operation in ("enable", "force"):
            assert f"alter table public.{table} {operation} row level security;" in sql
        policies = [part for part in all_statements if re.match(rf"create policy \w+ on public\.{table}\b", part, re.I)]
        assert policies and any("for select to authenticated, ventus_writer" in part for part in policies)
        for policy in policies:
            assert "(select auth.uid())" in policy and "to anon" not in policy
            assert "for delete" not in policy
            if "for update" in policy:
                assert "using (" in policy and "with check (" in policy and "to ventus_writer" in policy
        # Every core table participates directly in account erasure.
        definition = next(part for part in all_statements if re.match(rf"create table public\.{table}\b", part))
        assert "on delete cascade" in definition
    for part in all_statements:
        if re.match(r"grant\b", part, re.I):
            assert not re.search(r"\bto (?:anon|public|service_role)\b", part, re.I), "Unexpected API/admin grant"
            privileges = part.split(" on ", 1)[0]
            assert not re.search(r"\b(delete|truncate|all)\b", privileges, re.I), "Unexpected destructive grant"
            if "to authenticated" in part:
                assert part.startswith("grant select ") or part.startswith("grant execute on function public.")
        if match := re.match(r"create function (public|ventus_private)\.(\w+)\(", part):
            schema, name = match.groups()
            assert "set search_path = ''" in part
            body_match = re.search(r"as \$\$(.*)\$\$$", part, re.S)
            if body_match:
                body = body_match.group(1)
            else:
                assert schema == "ventus_private" and name == "request_user_id"
                assert "security invoker" in part and part.endswith("return auth.uid()")
                body = "select auth.uid();"
            statements(body)  # Inner quote/parenthesis balance only; NOT compilation.
            if schema == "public":
                public_functions.add(name)
                assert "security definer" in part and "set row_security = on" in part and "ventus_private.request_user_id()" in body
                assert re.search(rf"alter function public\.{name}\([^;]*\) owner to ventus_writer;", sql)
                assert re.search(rf"revoke all on function public\.{name}\([^;]*\) from public, anon, authenticated, service_role;", sql)
                assert re.search(rf"grant execute on function public\.{name}\([^;]*\) to authenticated;", sql)
            elif "security definer" in part:
                private_definers.add(name)
    assert public_functions == {
        "initialize_workspace", "update_settings", "create_category", "update_category", "create_task",
        "edit_task_tree", "set_task_completion", "postpone_task", "cancel_task", "soft_delete_task",
    }
    assert private_definers == {"guard_activity"}, "Review any new privileged private function"
    assert "alter function ventus_private.guard_activity() owner to postgres;" in sql
    assert "not exists (select 1 from auth.users u where u.id = old.owner_id)" in sql
    assert "create role ventus_writer nologin noinherit nobypassrls;" in sql
    assert "grant ventus_writer to postgres;" in sql
    assert "grant insert on public.task_activity to ventus_writer;" in sql
    assert "revoke create on schema public from ventus_writer;" in sql
    assert "unique (task_id, recurrence_key)" in sql and "check (recurrence_key = 'once')" in sql
    assert "unique (owner_id, creation_key)" in sql and "pg_catalog.sha256(" in sql
    assert "unique (occurrence_id, occurrence_version)" in sql
    assert "on delete no action deferrable initially deferred" in sql
    assert "on delete restrict" not in sql.lower()
    assert "task_schedules" not in sql and "root_event_index" not in sql and "request_payload" not in sql
    assert "original occurrence identity and deadline are immutable" in sql.lower()
    assert "Recurrence is unavailable until Milestone 4" in sql
    assert not re.search(r"\bexecute\s+(?:format\s*\(|')", sql, re.I), "Dynamic SQL requires review"
    assert not re.search(r"sb_secret_[A-Za-z0-9_-]{10,}|-----BEGIN .*PRIVATE KEY", sql)
    # No task helper/trigger acquires the settings-row lock; only initializer may.
    for part in all_statements:
        if part.startswith("create function") and "public.initialize_workspace(" not in part:
            assert not re.search(r"from public\.user_settings[^;]*for update", part, re.I)
    print(f"PASS: {len(FILES)} draft files, {len(TABLES)} tables, {len(public_functions)} public RPC definitions, {len(all_statements)} outer statements; lexical/security inventory only.")
    print("STATIC CHECK ONLY: does not compile SQL or verify database behavior; executes no SQL. See tests/RESULTS.md for separate local runtime evidence.")


if __name__ == "__main__":
    main()
