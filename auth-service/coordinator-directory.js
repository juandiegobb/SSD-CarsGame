'use strict';

function hasCoordinatorEndpointConflict(existing, candidate) {
  return Boolean(existing && (
    existing.publicUrl !== candidate.publicUrl ||
    existing.peerUrl !== candidate.peerUrl
  ));
}

module.exports = { hasCoordinatorEndpointConflict };
