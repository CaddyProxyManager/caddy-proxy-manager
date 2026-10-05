import { AuthentikFields } from "@cpm/controller/src/components/proxy-hosts/forward-auth/AuthentikFields";
import { DemoSurface } from "../DemoSurface";

/** Seeded from settings, as a host that has never been told anything of its own would be. */
export default function AuthentikDemo() {
  return (
    <DemoSurface>
      <AuthentikFields
        defaults={{
          outpostDomain: "auth.example.com",
          outpostUpstream: "http://authentik-outpost:9000",
          authEndpoint: "/outpost.goauthentik.io/auth/caddy",
        }}
      />
    </DemoSurface>
  );
}
