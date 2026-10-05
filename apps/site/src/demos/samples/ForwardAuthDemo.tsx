import { CpmForwardAuthFields } from "@cpm/controller/src/components/proxy-hosts/forward-auth/CpmForwardAuthFields";
import { DemoSurface } from "../DemoSurface";

/** One group let in, one webhook path let past - the two decisions this page is about. */
export default function ForwardAuthDemo() {
  return (
    <DemoSurface>
      <CpmForwardAuthFields
        cpmForwardAuth={{
          enabled: true,
          protected_paths: null,
          excluded_paths: ["/api/webhook"],
          require_captcha: true,
        }}
        currentAccess={{ userIds: [], groupIds: [2] }}
        groups={[
          { id: 1, name: "admins", description: "Runs the stack", member_count: 2 },
          { id: 2, name: "staff", description: null, member_count: 11 },
        ]}
        users={[
          { id: 1, email: "avery@example.com", name: "Avery", role: "admin" },
          { id: 2, email: "sam@example.com", name: "Sam", role: "user" },
        ]}
      />
    </DemoSurface>
  );
}
