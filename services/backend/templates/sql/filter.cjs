// Preserve the GraphQL filter tree instead of flattening nested relation filters.
const operators = [
    ['_not_starts_with', '$notStarts'], ['_not_ends_with', '$notEnds'], ['_not_contains', '$notContains'],
    ['_starts_with', '$starts'], ['_ends_with', '$ends'], ['_contains', '$contains'],
    ['_not_in', '$nin'], ['_every', '$every'], ['_none', '$none'],
    ['_not', '$ne'], ['_gte', '$gte'], ['_lte', '$lte'], ['_gt', '$gt'], ['_lt', '$lt'], ['_in', '$in'],
]
const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function filterGen(filter) {
    if (!filter) return {}
    const result = []
    for (const [key, value] of Object.entries(filter)) {
        if (key === 'AND' || key === 'OR') {
            result.push({ [key === 'AND' ? '$and' : '$or']: value.map(filterGen) })
            continue
        }
        const suffix = operators.find(([ending]) => key.endsWith(ending))
        let field = suffix ? key.slice(0, -suffix[0].length) : key
        if (field === 'id') field = '_id'
        if (!suffix) result.push({ [field]: value && typeof value === 'object' && !Array.isArray(value) ? filterGen(value) : value })
        else {
            const operator = suffix[1]
            if (['$starts', '$ends', '$contains', '$notStarts', '$notEnds', '$notContains'].includes(operator)) {
                const pattern = (operator.toLowerCase().includes('starts') ? '^' : '') + escape(value) + (operator.toLowerCase().includes('ends') ? '$' : '')
                const expression = { $regex: pattern, $options: 'i' }
                result.push({ [field]: operator.startsWith('$not') ? { $not: expression } : expression })
            } else result.push({ [field]: { [operator]: operator === '$every' || operator === '$none' ? filterGen(value) : value } })
        }
    }
    return result.length === 1 ? result[0] : { $and: result }
}
module.exports = { filterGen }
