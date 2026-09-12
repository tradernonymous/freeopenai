# The Antigravity proxy, pinned to one upstream release, plus the only thing the
# published image cannot do: start with accounts already in place.
#
# Pinned rather than tracking :latest, because the model ids it serves drift
# between releases and our provider pins the list it answers to -- a silent
# upstream change would look like a bug in this app.
FROM frieserpaldi/antigravity-proxy:0.7.0

# The upstream image runs as `bun` and owns /app/data. Seeding the account file
# is a write into a path that a mounted volume may own as root, so this runs as
# root to make that write dependable, then hands straight to the proxy. It is a
# private service with no inbound exposure, which is what makes that trade
# acceptable; if you ever give it a public domain, put authentication in front
# first (the proxy has none of its own).
USER root
COPY entrypoint.sh /usr/local/bin/antigravity-entrypoint
RUN chmod +x /usr/local/bin/antigravity-entrypoint

ENTRYPOINT ["/usr/local/bin/antigravity-entrypoint"]
