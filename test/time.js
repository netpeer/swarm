let start = 0

export const setStart = () => {
  start = Date.now()
}

export const getStart = () => {
  return start
}

export const getElapsed = () => {
  return Date.now() - start
}
