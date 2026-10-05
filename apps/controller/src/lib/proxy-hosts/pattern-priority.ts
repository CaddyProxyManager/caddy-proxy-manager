type HostPatternInfo = {
  normalized: string;
  wildcard: boolean;
  labelCount: number;
  suffixLength: number;
};

type RouteMatch = {
  host?: string[];
  path?: string[];
};

type RouteLike = {
  match?: RouteMatch[];
};

type TlsPolicyLike = {
  match?: {
    sni?: string[];
  };
};

type AutomationPolicyLike = {
  subjects?: string[];
};

function normalizeHostPattern(pattern: string) {
  return pattern.trim().toLowerCase().replace(/\.$/, "");
}

function getHostPatternInfo(pattern: string): HostPatternInfo {
  const normalized = normalizeHostPattern(pattern);
  const wildcard = normalized.startsWith("*.");
  const suffix = wildcard ? normalized.slice(2) : normalized;

  return {
    normalized,
    wildcard,
    labelCount: suffix ? suffix.split(".").length : 0,
    suffixLength: suffix.length,
  };
}

function getHostPriorityKey(info: HostPatternInfo) {
  return `${info.wildcard ? "wildcard" : "exact"}:${info.labelCount}`;
}

function getPathPriority(paths: string[]) {
  if (paths.length === 0) {
    return { hasPath: false, wildcard: true, length: 0 };
  }

  return paths.reduce(
    (best, path) => {
      const wildcard = path.endsWith("*");
      const candidate = {
        hasPath: true,
        wildcard,
        length: path.length,
      };

      if (!best.hasPath) {
        return candidate;
      }

      if (best.wildcard !== candidate.wildcard) {
        return candidate.wildcard ? best : candidate;
      }

      if (candidate.length !== best.length) {
        return candidate.length > best.length ? candidate : best;
      }

      return best;
    },
    { hasPath: false, wildcard: true, length: 0 },
  );
}

export function hostMatchesPattern(host: string, pattern: string): boolean {
  const normalizedHost = normalizeHostPattern(host);
  const info = getHostPatternInfo(pattern);

  if (!info.wildcard) {
    return normalizedHost === info.normalized;
  }

  const suffix = info.normalized.slice(2);
  if (!suffix || !normalizedHost.endsWith(`.${suffix}`)) {
    return false;
  }

  const subdomain = normalizedHost.slice(0, normalizedHost.length - suffix.length - 1);
  return subdomain.length > 0 && !subdomain.includes(".");
}

export function compareHostPatterns(a: string, b: string) {
  return compareHostInfo(getHostPatternInfo(a), getHostPatternInfo(b));
}

// The sorts below parse once up front rather than on every comparison.
function compareHostInfo(infoA: HostPatternInfo, infoB: HostPatternInfo) {
  if (infoA.wildcard !== infoB.wildcard) {
    return infoA.wildcard ? 1 : -1;
  }

  if (infoA.labelCount !== infoB.labelCount) {
    return infoB.labelCount - infoA.labelCount;
  }

  if (infoA.suffixLength !== infoB.suffixLength) {
    return infoB.suffixLength - infoA.suffixLength;
  }

  return infoA.normalized.localeCompare(infoB.normalized);
}

export function groupHostPatternsByPriority(patterns: string[]) {
  const sorted = patterns.map(getHostPatternInfo).sort(compareHostInfo);
  const groups: string[][] = [];
  let currentKey: string | null = null;

  for (const info of sorted) {
    const key = getHostPriorityKey(info);
    if (key === currentKey) {
      groups[groups.length - 1].push(info.normalized);
      continue;
    }
    groups.push([info.normalized]);
    currentKey = key;
  }

  return groups;
}

export function sortRoutesByHostPriority<T extends RouteLike>(routes: T[]) {
  return routes
    .map((route, index) => {
      const matches = route.match ?? [];
      const hosts = matches.flatMap((match) => match.host ?? []);
      return {
        route,
        index,
        hostCount: hosts.length,
        hostInfo: hosts.length > 0 ? getHostPatternInfo(hosts[0]) : null,
        pathPriority: getPathPriority(matches.flatMap((match) => match.path ?? [])),
      };
    })
    .sort((left, right) => {
      if (left.hostInfo && right.hostInfo) {
        const hostComparison = compareHostInfo(left.hostInfo, right.hostInfo);
        if (hostComparison !== 0) {
          return hostComparison;
        }
      } else if (left.hostCount !== right.hostCount) {
        return right.hostCount - left.hostCount;
      }

      const leftPathPriority = left.pathPriority;
      const rightPathPriority = right.pathPriority;

      if (leftPathPriority.hasPath !== rightPathPriority.hasPath) {
        return leftPathPriority.hasPath ? -1 : 1;
      }

      if (leftPathPriority.wildcard !== rightPathPriority.wildcard) {
        return leftPathPriority.wildcard ? 1 : -1;
      }

      if (leftPathPriority.length !== rightPathPriority.length) {
        return rightPathPriority.length - leftPathPriority.length;
      }

      return left.index - right.index;
    })
    .map(({ route }) => route);
}

/** Sort by the first pattern of each entry, entries with none last; stable for the rest. */
function sortByFirstPattern<T>(entries: T[], patternsOf: (entry: T) => string[]) {
  return entries
    .map((entry) => {
      const patterns = patternsOf(entry);
      return {
        entry,
        count: patterns.length,
        info: patterns.length > 0 ? getHostPatternInfo(patterns[0]) : null,
      };
    })
    .sort((left, right) =>
      left.info && right.info ? compareHostInfo(left.info, right.info) : right.count - left.count,
    )
    .map(({ entry }) => entry);
}

export function sortTlsPoliciesBySniPriority<T extends TlsPolicyLike>(policies: T[]) {
  return sortByFirstPattern(policies, (policy) => policy.match?.sni ?? []);
}

export function sortAutomationPoliciesBySubjectPriority<T extends AutomationPolicyLike>(
  policies: T[],
) {
  return sortByFirstPattern(policies, (policy) => policy.subjects ?? []);
}
