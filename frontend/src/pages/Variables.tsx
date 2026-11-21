import '@/pages/Variables.css'

/**
 * The Variables reference page. It answers the reported question directly:
 * the syntax is the bare name, and every number field in a feature editor
 * reads the variables defined above that feature in the list.
 */
export default function Variables() {
  return (
    <div className="variables-page">
      <div className="variables-content">
        <h1>Variables</h1>
        <p>
          A variable is a named number in the part's feature list. Add one with
          <strong> Add Variable</strong>, name it, and write its value in the
          Expression box. Every later number field can then use the name.
        </p>

        <h2>Syntax</h2>
        <p>
          Write the bare name inside any ordinary math expression. There is no
          prefix and no braces.
        </p>
        <pre className="variables-example">{`width
width * 2
width / 2 + 5
sqrt(width)`}</pre>
        <p>
          The field shows the value it evaluates to (<code>= 40</code>) while the
          document keeps the expression itself, so editing the variable updates
          every field that names it on the next solve.
        </p>

        <h2>Extrude example</h2>
        <ol className="variables-steps">
          <li>Add Variable, name it <code>width</code>, and set its Expression to <code>40</code>.</li>
          <li>Add an Extrude below it and type <code>width</code> into Distance. The field reads <code>= 40</code>.</li>
          <li>Change the variable to <code>25</code>. The extrude becomes 25 tall.</li>
        </ol>

        <h2>Which variables a field can use</h2>
        <p>
          Only the variables defined <em>above</em> the feature in the list. A
          name defined below it is refused as "defined below this feature";
          move that variable up to use it. A variable's own Expression box reads
          the variables above it, never itself.
        </p>

        <h2>Names that do not work</h2>
        <ul className="variables-mistakes">
          <li><code>#var</code> is not math: the field asks for a bare name.</li>
          <li><code>{'{var}'}</code> is a math object, not a number.</li>
          <li><code>$var</code> is a different name (a <code>$</code> may start a variable name), so it reads as unknown unless you defined exactly that.</li>
        </ul>
        <p>
          A refused field says which name it did not find and lists the ones it
          can use.
        </p>
      </div>
    </div>
  )
}
