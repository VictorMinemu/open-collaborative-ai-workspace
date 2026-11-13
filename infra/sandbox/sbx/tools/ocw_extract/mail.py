"""E-mail (phase 07.17.1.1.1, D-04, D-09, PD-13): `.eml` through the stdlib parser (`policy.default`) in a child
interpreter, `.msg` through Debian's `msgconvert` to `.eml` first. Prints the headers, the text body (HTML converted
without scripts or styles when there is no text part) and one `### attachment:` line per attachment; attachments are
listed, never written out."""

import email
import email.policy
import os
import sys

from . import bounds, runner, text

HEADERS = ("From", "To", "Cc", "Subject", "Date")


def eml_child(args):
    """Child entry: `eml_child <path>` writes the message as text to stdout."""
    with open(args[0], "rb") as f:
        data = f.read(bounds.OUTPUT_FILE_MAX_BYTES)
    try:
        msg = email.message_from_bytes(data, policy=email.policy.default)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"not a readable e-mail message: {exc}\n")
        return bounds.EXIT_FAILED
    if not any(msg.get(h) for h in HEADERS):
        sys.stderr.write("not an e-mail message: no From, To, Subject or Date header\n")
        return bounds.EXIT_FAILED
    out = []
    for h in HEADERS:
        value = msg.get(h)
        if value:
            out.append(f"{h}: {' '.join(str(value).split())}")
    body = msg.get_body(preferencelist=("plain", "html"))
    out.append("")
    if body is not None:
        content = body.get_content()
        if body.get_content_type() == "text/html":
            content = text.html_to_text(content.encode("utf-8"))
        out.append(content.strip("\n"))
    else:
        out.append("[no text body]")
    for part in msg.iter_attachments():
        name = part.get_filename() or "(no name)"
        payload = part.get_payload(decode=True) or b""
        out.append(f"### attachment: {' '.join(name.split())} · {part.get_content_type()} · {len(payload)} bytes")
    sys.stdout.buffer.write(bounds.clean_text("\n".join(out)).encode("utf-8"))
    return 0


def read_eml(path, steps):
    res = steps.python("ocw_extract.mail", "eml_child", path)
    if res.returncode != 0:
        raise bounds.ConversionError(f"could not read {os.path.basename(path)}: {res.err_line() or 'damaged message'}")
    return res.stdout.decode("utf-8", "replace")


def extract(path, type_name, opts):
    steps = opts.steps
    doc = bounds.Doc(type_name, "email")
    if type_name == "msg":
        eml = os.path.join(runner.current_scratch(), "message.eml")
        res = steps("msgconvert", ["msgconvert", "--outfile", eml, path])
        if res.returncode != 0 or not os.path.isfile(eml):
            raise bounds.ConversionError(
                f"msgconvert could not read {os.path.basename(path)} as an Outlook message: "
                f"{res.err_line() or 'not an Outlook .msg file'}"
            )
        doc.method = "msgconvert+email"
        try:
            doc.add(read_eml(eml, steps))
        finally:
            os.unlink(eml)
        return doc
    doc.add(read_eml(path, steps))
    return doc
